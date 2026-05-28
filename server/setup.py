from setuptools import find_packages, setup


setup(
    name="auto-video-cleaner-server",
    version="0.1.0",
    description="FastAPI backend for automatic spoken-video cleanup.",
    packages=find_packages(),
    python_requires=">=3.9",
    install_requires=[
        "fastapi>=0.115.0",
        "python-multipart>=0.0.18",
        "uvicorn[standard]>=0.32.0",
    ],
    extras_require={
        "ai": ["faster-whisper>=1.1.0"],
    },
)
