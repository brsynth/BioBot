<p align="center">
  <img src="biobot/static/logo.png" alt="BioBot logo" width="300"/>
</p>

<p align="center">
  <strong>AI-powered protocol generation for programmable biology instruments</strong>
</p>

<p align="center">
  <em>Ask a quesiton or describe your experiment in plain English and get an answer or executable code for your biology instrument.</em>
</p>

---

BioBot is a robot-agnostic web assistant that generates, validates, and iterates on automation protocols for programmable biology instruments. A fresh install contains no robot documentation, preset platform registry, or robot SDKs; a shared device catalog is built in the background once an API key is available, and additional devices are discovered on demand. It combines a conversational chat interface with a RAG (Retrieval-Augmented Generation) pipeline, an interactive deck visualizer, and a code validation loop to produce working scripts from natural language descriptions.
It helps users interact with an AI assistant to get guidance, protocols, and device-compatible files for automating lab workflows.

Device brands and models are runtime knowledge, never application rules. BioBot discovers documentation, physical layouts, instruments, mounting identifiers, protocol formats and validation tools when users select a device, then stores and reuses them. New device support must come from these data and capabilities; do not add device-specific branches, SDK keywords, model names, mount names or well-layout defaults to the application source.

---

## Features

### Protocol Generation
- **Natural language → working code.** Describe what you want ("serial dilution, 1:10, 8 steps, 96-well plate") and BioBot generates a complete, executable protocol.
- **Structured clarification.** BioBot generates a questionnaire with numeric bounds and relationships inferred from the request. Answers are checked locally as you advance, and submitted parameters are reviewed for completeness and consistency before code generation.
- **Self-correcting generation loop.** Generated code is automatically simulated. If it fails, errors are fed back to the LLM for correction (up to 3 attempts) before delivering the final result.
- **Reverse semantic check.** After simulation passes, a second LLM call verifies that the code actually matches what the user asked for, not just that it runs without errors.

### First-launch device catalog
- **Background inventory.** Once a deployment API key or the first signed-in user's key is available, BioBot discovers an initial inventory from primary online sources, verifies each model's programmability, and stores its instruction profile and shared visual workspace locally. Startup stays responsive.
- **Requests during the build.** Ready entries are reused. A request for a device already being built waits for that same entry; another model is discovered separately, without waiting for the whole inventory. The landing page shows progress and failures remain retryable.
- **One identity per physical model.** Verified manufacturer, model and physical variant form the device identity; display names and model-generated IDs do not. Documented naming variants are persistent aliases. Database uniqueness and transactional identity assignment prevent concurrent alias requests from creating another device or deck. Similar model names and different physical variants remain separate.
- **Existing catalogs.** Startup reconciles exact, verified name bridges and rechecks older profiles in the background. Legacy IDs, poll links and device names resolve to the canonical record. Former default decks remain selectable shared alternatives with the same UUIDs; private copies, protocol text and cached protocol bindings remain intact. Previous catalog records are retained in the alias rows and `device_identity_merges`. No device-specific name-removal rules or brand lists are used.
- **Resumable and shared.** PostgreSQL stores the discovery queue, profiles, features, constraints, instruction formats, source evidence and build progress. Per-device locks prevent duplicate integration across server processes. An interrupted build resumes on launch or the next authenticated request; API keys are never stored in catalog rows.
- **Initial scope.** The initial inventory targets 50 models by default, across discovered manufacturers and applications, without a fixed list of device kinds. `BIOBOT_CATALOG_INITIAL_LIMIT` changes this initial batch size (`0` searches until no additional models are found). This is a growing catalog, not a claim to exhaustively list every instrument. Other models remain available on request. Set `BIOBOT_CATALOG_ENABLED=0` to disable the automatic inventory build while retaining on-demand discovery.

### Category landing constellation
The landing page uses available catalog categories rather than previously used devices. Floating category bubbles stay outside the title/composer area. An opened bubble expands around its original center while the other categories move aside; closing it restores their original constellation. Connected device links float around the opened bubble, with paging adjusted to the available space. Device links open the saved workspace, including when opened in a new tab. Reduced-motion preferences disable floating animation. Smaller screens gain vertical space without overlapping the composer. The signed-in catalog endpoint exposes only ready device names, keys, categories and status.

### Administration
Set `BIOBOT_ADMINS` to the server owners' comma-separated email addresses, then use the shield button in the account menu to open the dedicated `/admin` workspace. Its interface is separate from protocol chat, with Users and Devices sections. The User/Admin switch returns to the regular workspace. Approved administrators also have access.

- **Users tab:** review access requests and edit names, email, job role, country and administrator access. Password resets require a new password, revoke existing sessions and clear the password-encrypted API key; chats and protocols remain saved. Server owner addresses cannot be reassigned through this view.
- **Devices tab:** search the local inventory, expand the equipment category cloud or search the catalog, and edit categories, features, constraints (with scope, units, increments, bounds and optional validation formulas), instruction language/format, extension, programming interface and physical workspace geometry. For example, an increment of `2.5` with unit `nL` remains explicit rather than being silently treated as microlitres.
- **Equipment categories:** a device can belong to multiple editable families (for example Liquid handling or Imaging & microscopy). Discovery assigns categories from documented capabilities; older entries infer them from saved features until an administrator sets explicit categories. Custom families are supported, and legacy unclassified entries remain visible under Uncategorized. New and resumed catalog builds require a non-placeholder category before becoming ready, combining discovered labels with families recognized from documented capabilities. Missing classification fails visibly and can be retried rather than silently publishing an uncategorized entry. Categories organize equipment without limiting supported device types. The Devices cloud expands each family into clickable device names. Search automatically opens matching families, highlights matched text, and shows a unique device result count; Reset view clears search and selections.
- **Deck editing in Devices:** expand a category in the equipment cloud or search to find and select a saved device; its capabilities and physical deck appear together. Edit device and Edit deck are independent pressed/unpressed toggles; hiding either editor preserves its unsaved draft. Inspect its physical map, edit position IDs, coordinates, dimensions, hardware labels and fixed components, or add/remove positions. Spatial components can be dragged. Saved ordinal layouts can be converted to explicitly relative coordinate geometry. Save updates the shared default while preserving private copies and instruction profiles; discard restores the saved draft. Existing track positions remain visible even when no carriers are loaded.
- **Update (Devices tab):** checks existing instruments against primary online sources, refreshes profiles without changing saved deck geometry, and searches for additional programmable models. Administrator-edited profiles retain their corrections while new source references are appended. Existing ready devices stay usable when an online check fails, with errors reported for retry. Each update can discover up to `BIOBOT_CATALOG_INITIAL_LIMIT` additional instruments (default 50; 0 means no cap), even after the initial inventory limit has been reached. Update uses the configured or signed-in user API key and shows progress.
- **RESET DB (Devices tab):** confirms a catalog-wide reset, clears learned profiles and requeues all saved device identities, then rebuilds categories, constraints, instruction profiles and shared decks from sources. Users, chats, saved protocols, personal decks and stable model aliases are preserved; existing shared decks remain available until their replacements are ready. Active discovery or editing blocks reset to prevent conflicting writes. The rebuild has live progress and is recorded in the administrator audit log. An explicit reset starts rebuilding even when automatic startup discovery is disabled.
- **Reset from sources:** queues fresh verification, instruction discovery and default workspace generation for that device. It replaces administrator corrections after discovery succeeds, retains personal layout copies and saved protocols, and keeps the previous default geometry until the replacement is ready. Active builders cannot be edited or reset concurrently. Administrators can refresh the device list to follow progress.
- **Runtime corrections:** saved profile changes inform future protocol generation and export. Explicit simulator formulas are carried into structured protocol validation; descriptive constraints without formulas inform generation. Administrator mutations require a session token and are recorded in `admin_audit` without passwords or API keys.

### Device workspaces
- **Any programmable biology instrument.** Device discovery covers sample preparation, imaging, measurement, thermal control, cultivation, separation, fabrication and robotic manipulation; these are examples, not a fixed device list. Specify the manufacturer and physical model.
- **Local data first.** Existing database layouts reopen without regeneration. New layouts use the selected device's local reference documents first, then search online when those references do not establish its geometry.
- **Documented geometry.** New workspaces use one coordinate-based representation for any physical context discovered from references, with proportional positions, sizes and shapes; no fixed list of contexts or device templates is used. Previously saved layout formats remain readable. Sources and uncertainties appear below the view. Missing geometry stays explicitly unavailable instead of showing invented hardware.
- **General operations.** Structured protocols can describe instrument operations and their settings without requiring liquid transfers, wells or pipettes. Documented numeric operation constraints are checked locally; scientific behavior still requires device-specific validation.

### Interactive Deck Visualizer
- **Split-screen deck layout** alongside the chat, showing the robot's worktable with all labware, pipettes, and modules.
- **Platform-adaptive rendering.** The protocol determines whether the deck is shown as a grid, carriers on tracks, or source/destination plate maps.
- **Reusable deck library.** A device's physical layout is generated once and stored in PostgreSQL. Protocol contents and steps are cached privately per user and file, so reopening a deck makes no model calls.
- **Copies and community alternatives.** Choose a saved layout in the deck panel, use **Edit a copy** to change its geometry or default hardware, then **Save copy**. Copies are private until their owner clicks **Publish**; other users can then select them for the same device. Choosing a layout preserves the current protocol's actual labware and steps.
- **Click, double-click, and drag-and-drop** to move labware, swap slots, change instruments, and edit parameters. The code updates in real time.
- **Automatic coherence.** Changing a pipette auto-updates the tiprack; changing labware validates well references; volume edits are checked against pipette ranges.

### User Feedback Loop
- **Thumbs up (👍)** on a code block saves it as a verified working protocol into the documentation folder for the corresponding platform. Future generations retrieve these as examples via RAG.
- **Thumbs down (👎)** opens a remark field where you describe what went wrong. The failed code + your notes are saved as negative examples, teaching the system what to avoid.
- The RAG index rebuilds automatically after each feedback action, the system improves with every use.

### Authentication & Security
- **Conversation Trash.** The sidebar trash icon moves a conversation immediately without deleting its messages. Open **Trash** in the sidebar and use **Restore** to return it to the active conversation list.
- User registration with hashed passwords.
- API key encryption at rest using Fernet symmetric encryption.
- Chat message encryption using a server-side key.

---

## How Code Generation Works

When a user asks BioBot for a protocol, the request goes through a multi-stage pipeline that classifies the intent, gathers missing information, retrieves relevant documentation, generates code, and validates it, all before the user sees a single line of output.

**Classification.** The user's message is first sent to a lightweight LLM (GPT-4o-mini) that classifies it as one of three categories: *code* (the user wants a protocol script), *general* (a question about lab automation that doesn't require code), or *out* (unrelated to lab automation). General and out-of-scope messages are handled by a standard streaming chat response. Code requests enter the RAG pipeline.

**Sufficiency check.** The shared dispatcher checks completeness before choosing chat or generation. Missing protocol details are collected together in one questionnaire, with justified defaults for routine choices. The stepper supports suggested answers, custom quantities with units, and “Don't know.” Numeric constraints are checked as the user advances; submitted answers are reviewed for consistency before generation.

**Consolidation.** Multi-turn conversations are common, the user might say "serial dilution" in the first message, then "use my specified pipette" in a follow-up, then answer the structured questions in a third. Before retrieval, a consolidation step merges the entire conversation into one self-contained protocol description, as if the user had provided everything upfront. This ensures the RAG retrieval and code generation see the complete picture regardless of how the conversation unfolded.

**Retrieval.** The consolidated request is embedded using OpenAI's text-embedding model and searched against a FAISS vector index built from the platform's documentation (API references, labware guides, example protocols, and user-verified working code from the feedback system). The top-K most relevant documentation chunks are retrieved and injected into the generation prompt as context.

**Generation.** The LLM receives the consolidated request, the retrieved documentation chunks, and a system prompt tailored to the detected platform. It generates a complete protocol script.

**Simulation and validation.** The generated code goes through a validation step to catch errors before reaching the user. When a platform-specific simulation tool is available, BioBot runs the code against it, validating labware definitions, instrument constraints, and deck configuration without touching any hardware. When no simulator is available, BioBot falls back to an LLM-based validation: the generated script is compared against reference protocols, official documentation, and verified working code retrieved from the RAG index. The LLM checks for API misuse, invalid function calls, incompatible hardware combinations, and logical errors (such as aspirating more volume than a well contains or referencing a labware position that doesn't exist). If either validation method reports errors, the error details are fed back to the LLM along with the original code and request, and the generation step repeats. This correction loop runs up to 3 times, producing progressively cleaner output with each iteration.

**Reverse check.** Once the simulation passes, one final LLM call compares the generated code against the user's original request to verify semantic correctness. A protocol that runs without errors but performs the wrong experiment is caught here. If the reverse check suggests corrections, they are applied and re-simulated.

**Streaming.** The final validated code is streamed to the browser token-by-token. Throughout the pipeline, status messages ("Analyzing your request...", "Searching documentation...", "Attempt 2.. correcting errors...") are streamed to the frontend so the user sees progress in real time rather than a silent wait.

---

## Getting Started

### Prerequisites

- Docker with Docker Compose v2.24.0 or newer
- An OpenAI API key for AI features (enter it in the app)

### 1. Clone the repository

```bash
git clone https://github.com/brsynth/BioBot.git
cd BioBot
```

### 2. Build and start

No `.env` file is needed:

```bash
docker compose up --build -d
```

### 3. Access the app

Open http://localhost:5000 and register an account. Enter your OpenAI API key
at registration or add it later in Settings. You can start the app and create
an account without a key; AI features require one.

Database settings have local defaults. BioBot generates a random secret on first
startup and saves it in the `app_data` Docker volume so sessions and encrypted
chats remain usable after restarts. Keep this volume alongside `db_data`.

### 4. Check logs or stop

```bash
docker compose logs -f biobot
```

```bash
docker compose down
```

### Optional configuration

Compose still reads a `.env` file if present. For a shared deployment, override
the database password and set a stable `FLASK_SECRET_KEY`. The default web port
is bound to localhost; change the port binding if remote access is needed.

```dotenv
DB_HOST=postgres
DB_PORT=5432
DB_NAME=biobotdb
DB_USER=biobotuser
DB_PASSWORD=your_db_password
FLASK_SECRET_KEY=your_random_secret_key

# Optional default API key for new accounts
API_KEY=your_openai_api_key

# Optional password-reset email: Resend or SMTP
RESEND_API_KEY=re_your_resend_key
# SMTP_HOST=smtp.gmail.com
# SMTP_PORT=587
# SMTP_USER=your_email@gmail.com
# SMTP_PASSWORD=your_app_password
```

---

## Project Structure

```
BioBot/
├── biobot/
│   ├── app.py                  # Flask routes
│   ├── engine.py               # Chat and RAG dispatch
│   ├── main_rag.py             # Retrieval, protocol design, export, validation
│   ├── protocol_lang.py        # BioBot protocol language: expansion and checks
│   ├── handlers.py             # On-demand platform discovery
│   ├── doc_fetcher.py          # On-demand documentation download
│   ├── doc_loader.py           # Documentation parsing
│   ├── config.py               # Database and secrets
│   ├── crypt.py                # Encryption
│   ├── deck_visualizer.py      # Generic deck extraction and edits
│   ├── deck_library.py         # Persistent device layouts, copies, and private protocol cache
│   ├── feasibility_check.py    # Protocol feasibility review
│   ├── email_service.py        # Password-reset email
│   ├── templates/              # Chat and authentication pages
│   ├── static/                 # UI and universal deck renderer
│   └── data/                   # Generated at runtime; ignored by Git
├── tests/
├── docker-compose.yml
├── Dockerfile
├── requirements.txt
└── .env.example                # Optional configuration
```

---

## Usage

1. **Register** a new account or log in.
2. **Start a chat** and describe your protocol in plain English. Use **Edit** under a previous prompt, then **Save & regenerate**, to correct it. Saving replaces all replies and messages after that prompt; **Cancel** keeps the conversation unchanged.
3. If BioBot needs more details, it presents **structured questions** select your options and click "Generate Protocol."
4. BioBot writes the protocol in its own vendor-agnostic language ([PROTOCOL_LANGUAGE.md](PROTOCOL_LANGUAGE.md)) and checks it in the simulator.
5. The deck opens with the labware, liquids and ordered operations. Play through the steps, inspect wells, drag labware, change instruments, and edit parameters; changes update the protocol.
6. Click **Export code** to generate the device-specific code from the current protocol.
7. Test the code on your robot. Click **👍** if it works, **👎** if it doesn't (with a note about what went wrong). Your feedback improves future generations.

---

## Documentation for RAG

BioBot starts with no bundled platform documentation or fixed device registry. The initial catalog build discovers models and instruction profiles online; a user can request any model while it runs. Model-specific documentation is downloaded and indexed when needed, and local resources are reused. If no device is specified, BioBot asks for one.

All learned platform information is runtime data, excluded from Git:

```
biobot/data/
├── handlers.json               # Discovered platform settings
└── docs/
    └── <platform_id>/
        ├── reference.txt        # Downloaded documents (.rst, .txt, .pdf)
        ├── rag_store_<platform_id>.pkl
        ├── codes/               # Verified protocols, stored as text
        └── failed_codes/        # Failed protocols and user remarks
```

In Docker, `/app/data` is stored in the persistent `app_data` volume. Subsequent
runs reuse downloaded documentation and cached indexes. Feedback invalidates the
corresponding index so it rebuilds with the new examples. You can also add your
own documentation to the discovered platform's folder.

Robot SDKs and simulators are not installed by default. Discovered platforms use
LLM review; an administrator can install a simulator and configure `simulate_cmd`
and `validation_strategy` in the runtime registry when needed. Resetting with
`docker compose down -v` also removes downloaded documentation and the registry.

---
