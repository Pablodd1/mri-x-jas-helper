import os
from pydantic_settings import BaseSettings
from functools import lru_cache


class Settings(BaseSettings):
    # AI Providers
    ollama_base_url: str = "http://localhost:11434"
    ollama_model: str = "llava-llama3"  # or "medllava"
    kimi_api_key: str = ""
    minimax_api_key: str = ""
    minimax_api_url: str = "https://api.minimax.io"
    deepgram_api_key: str = ""

    # Storage
    database_url: str = ""
    aws_access_key_id: str = ""
    aws_secret_access_key: str = ""
    aws_s3_bucket: str = "mri-x-jas-helper"
    aws_region: str = "us-east-1"

    # App
    node_env: str = "development"
    session_secret: str = os.urandom(32).hex()
    port: int = 8080
    cors_origin: str = "http://localhost:3000"

    class Config:
        env_file = ".env"
        extra = "allow"


@lru_cache()
def get_settings() -> Settings:
    return Settings()
