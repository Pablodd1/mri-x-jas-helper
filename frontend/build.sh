#!/bin/bash
# Build script for MedView Pro - generates config.js from Vercel env vars
set -e

echo "Generating config.js from environment variables..."

if [ -n "$SUPABASE_URL" ] && [ -n "$SUPABASE_KEY" ]; then
  cat > public/config.js << EOF
const SUPABASE_URL = '${SUPABASE_URL}';
const SUPABASE_KEY = '${SUPABASE_KEY}';
EOF
  echo "config.js generated successfully"
else
  echo "WARNING: SUPABASE_URL or SUPABASE_KEY not set. Using example config."
  cp public/config.example.js public/config.js
fi
