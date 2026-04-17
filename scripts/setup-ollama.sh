#!/bin/bash
# MRI X Jas Helper — Ollama Model Setup
# Run this on your GPU machine to install local vision models

set -e

echo "🤖 MRI X Jas Helper — Ollama Model Setup"
echo ""

# Check if Ollama is installed
if ! command -v ollama &> /dev/null; then
    echo "❌ Ollama not found. Install from: https://ollama.ai"
    echo "   Or run: curl -fsSL https://ollama.ai/install.sh | sh"
    exit 1
fi

echo "✅ Ollama found"
ollama --version
echo ""

# Pull recommended models
MODELS=(
    "llava-llama3:latest"        # Main vision model — general medical images
    "llava:7b"                  # Alternative vision model
    "gemma3:4b"                 # Fast general inference
    "gemma3:12b"                # Better accuracy, needs more VRAM
    "qwen2.5-coder:7b"          # Code/structured tasks (not medical, but useful for report formatting)
)

echo "📦 Pulling recommended models..."
echo ""

for model in "${MODELS[@]}"; do
    echo "Pulling $model..."
    ollama pull "$model"
    echo ""
done

echo "✅ All models installed!"
echo ""
echo "📋 Installed models:"
ollama list
echo ""
echo "🚀 To start Ollama: ollama serve"
echo "🌐 Then run: docker compose up (from project root)"
