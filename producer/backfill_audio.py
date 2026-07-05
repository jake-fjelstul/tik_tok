import os
import sys
import argparse
import threading
import requests
import concurrent.futures
from pathlib import Path
from dotenv import load_dotenv
from supabase import create_client, Client

# 1. Load environment variables from parent directory's .env.local
base_dir = Path(__file__).resolve().parent.parent
env_path = base_dir / ".env.local"
load_dotenv(dotenv_path=env_path)

supabase_url = os.environ.get("SUPABASE_URL")
supabase_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

kokoro_base_url = os.environ.get("KOKORO_BASE_URL")
kokoro_api_key = os.environ.get("KOKORO_API_KEY", "kokoro")
kokoro_model = os.environ.get("KOKORO_MODEL", "kokoro")
kokoro_voice = os.environ.get("KOKORO_VOICE", "af_heart")

# Global threading locks and counters
progress_lock = threading.Lock()
success_count = 0
error_count = 0


def synth(text: str, voice: str, model: str) -> bytes:
    """
    Synthesizes voiceover from text using Kokoro's OpenAI-compatible endpoint.
    Returns the raw mp3 bytes.
    This is isolated so it can easily be swapped with other services (e.g. ElevenLabs, OpenAI).
    """
    # If the configured URL ends with /v1, the standard OpenAI endpoint is /v1/audio/speech
    url = f"{kokoro_base_url}/audio/speech"
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {kokoro_api_key}"
    }
    payload = {
        "model": model,
        "input": text,
        "voice": voice,
        "response_format": "mp3"
    }
    
    response = requests.post(url, json=payload, headers=headers, timeout=45)
    response.raise_for_status()
    return response.content


def process_row(supabase_client: Client, row: dict, voice: str, model: str, bucket: str, prefix: str) -> str:
    """
    Worker function to voice, upload, and update a single content row.
    """
    row_id = row["id"]
    body = row["body"]
    if not body:
        raise ValueError("Empty body")
    
    # 1. Synthesize audio bytes
    audio_bytes = synth(body, voice, model)
    
    # 2. Upload file to Supabase Storage
    storage_key = f"{prefix}{row_id}.mp3"
    supabase_client.storage.from_(bucket).upload(
        path=storage_key,
        file=audio_bytes,
        file_options={"content-type": "audio/mpeg", "upsert": "true"}
    )
    
    # 3. Update content row with storage key path
    supabase_client.table("content").update({"audio_path": storage_key}).eq("id", row_id).execute()
    
    return row_id


def main():
    global success_count, error_count
    
    parser = argparse.ArgumentParser(description="On-demand TTS backfill script for LearnFeed.")
    parser.add_argument("--types", default="fact", help="Comma-separated content types to process (e.g. fact,quiz)")
    parser.add_argument("--concurrency", type=int, default=4, help="Thread pool worker count (1 = sequential)")
    parser.add_argument("--prefix", default="", help="Deterministic storage filename prefix (e.g. tts_)")
    parser.add_argument("--voice", help="Kokoro voice override")
    parser.add_argument("--model", help="Kokoro model override")
    parser.add_argument("--bucket", default="narration", help="Supabase storage bucket name")
    args = parser.parse_args()

    # Preflight Check 1: Kokoro base URL configuration guard
    if not kokoro_base_url:
        print("Kokoro is not configured (KOKORO_BASE_URL env var is empty). Script no-ops.")
        sys.exit(0)

    # Preflight Check 2: Kokoro endpoint reachability
    print(f"Checking Kokoro reachability at {kokoro_base_url}...")
    try:
        # Check connectivity (expecting 200/404/405 without raising connection error)
        requests.get(kokoro_base_url, timeout=5)
    except requests.exceptions.RequestException as e:
        print(f"Error: Kokoro server at {kokoro_base_url} is not reachable: {e}")
        sys.exit(1)
    print(" -> Kokoro is reachable.")

    # Preflight Check 3: Supabase env var credentials
    if not supabase_url or not supabase_key:
        print("Error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables must be defined.")
        sys.exit(1)

    print("Connecting to Supabase and verifying storage bucket...")
    supabase: Client = create_client(supabase_url, supabase_key)

    # Preflight Check 4: Confirm target storage bucket exists
    try:
        buckets = supabase.storage.list_buckets()
        if not any(b.name == args.bucket for b in buckets):
            print(f"Error: Target storage bucket '{args.bucket}' does not exist in your Supabase project.")
            sys.exit(1)
    except Exception as e:
        print(f"Error: Failed to verify storage buckets: {e}")
        sys.exit(1)
    print(f" -> Storage bucket '{args.bucket}' verified.")

    # Parse inputs
    content_types = [t.strip() for t in args.types.split(",")]
    voice = args.voice or kokoro_voice
    model = args.model or kokoro_model
    
    print(f"Starting backfill query for types: {content_types}...")

    # Paginate and query rows with null audio_path
    page = 0
    limit = 500
    pending_rows = []
    
    while True:
        start = page * limit
        end = start + limit - 1
        try:
            response = supabase.table("content") \
                .select("id, body") \
                .is_("audio_path", "null") \
                .in_("type", content_types) \
                .range(start, end) \
                .execute()
            
            rows = response.data
            if not rows:
                break
            pending_rows.extend(rows)
            if len(rows) < limit:
                break
            page += 1
        except Exception as e:
            print(f"Error querying pending content: {e}")
            sys.exit(1)

    total_pending = len(pending_rows)
    print(f"Found {total_pending} rows needing audio voiceover.")
    
    if total_pending == 0:
        print("All matching content cards already have audio. Nothing to do.")
        sys.exit(0)

    # Voice synthesis execution
    print(f"Processing with voice='{voice}', model='{model}', concurrency={args.concurrency}...")
    
    # Run with thread pool executor
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.concurrency) as executor:
        futures = {
            executor.submit(process_row, supabase, row, voice, model, args.bucket, args.prefix): row
            for row in pending_rows
        }
        
        for future in concurrent.futures.as_completed(futures):
            row = futures[future]
            try:
                row_id = future.result()
                with progress_lock:
                    success_count += 1
                    total_processed = success_count + error_count
                    print(f"[{total_processed}/{total_pending}] Synthesized & uploaded audio for ID: {row_id}")
            except Exception as e:
                with progress_lock:
                    error_count += 1
                    total_processed = success_count + error_count
                    print(f"[{total_processed}/{total_pending}] ❌ Error processing ID {row['id']}: {e}")

    print("\n=== BACKFILL COMPLETE ===")
    print(f"{success_count} synthesized, {error_count} errors")


if __name__ == "__main__":
    main()
