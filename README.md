# BioBot 🧪🤖

BioBot is a web application and chatbot designed for laboratory automation, particularly with liquid handling robots. It helps users interact with an AI assistant to get guidance, protocols, and Python code for automating lab workflows.

---

## Features

- **User Registration and Login:** Secure authentication system with hashed passwords.
- **Chat Interface:** Talk to the BioBot assistant with context-aware replies.
- **Code Generation:** Generates Python code for lab automation protocols.
- **RAG (Retrieval-Augmented Generation):** Fetches relevant documentation and generates answers for lab-related queries.
- **Dockerized Deployment:** Easy to deploy with Docker and Docker Swarm, supporting secrets for API keys.
- **Persistent Chat History:** Stores user chats and allows multiple concurrent conversations.
- **Secure API Key Handling:** Supports API key retrieval via Docker secrets or environment variables.

---

## Tech Stack

- **Backend:** Python 3.10, Flask
- **AI Models:** GPT-5 via OpenAI API
- **Database:** SQLite or PostgreSQL (depending on your setup)
- **Containerization:** Docker, Docker Compose, Docker Swarm
- **Frontend:** HTML/CSS/JS (templates in `UI2/`)

---

## Getting Started (Step by Step)

### 1. Clone the repository

```bash
git clone https://github.com/brsynth/BioBot.git
cd BioBot
```

### 2. Define your configuration values in the .env file
```bash
DB_HOST=postgres
DB_PORT=5432
DB_NAME=your_db_name
DB_USER=your_db_user
DB_PASSWORD=your_db_password
API_KEY=your_openai_api_key
```
### 3. Build the image
```bash
sudo docker compose build
sudo docker compose up -d
```
### 4. Check and acces the logs
```bash
sudo docker compose logs -f biobot #or the service name if it's not bibot
```
### 5. Access the app
The app will be accessible via
```cpp
http://127.0.0.1:5000
```
## Usage
- Register as a new user or log in with an existing account.

- Start a conversation in the chat interface.

- Ask general lab questions or request code generation for lab protocols.

- The system will classify your request, fetch documentation, and generate Python code if needed.

- All chats are stored in the database and used to provide BioBot with memory.