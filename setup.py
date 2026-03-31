from setuptools import setup, find_packages

setup(
    name="biobot-cli",
    version="0.1.0",
    packages=["cli"],
    install_requires=[
        "openai>=1.50.0",
        "numpy>=1.24.0",
        "faiss-cpu>=1.7.0",
        "requests>=2.28.0",
        "beautifulsoup4>=4.12.0",
        "tiktoken>=0.5.0",
        "psycopg2-binary>=2.9.0",
        "werkzeug>=3.0.0",
        "cryptography>=41.0.0",
        "python-dotenv>=1.0.0",
    ],
    entry_points={
        "console_scripts": [
            "biobot=cli.cli:main",
        ],
    },
    python_requires=">=3.10",
)