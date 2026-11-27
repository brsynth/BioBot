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
- **Resumable and shared.** PostgreSQL stores the discovery queue, profiles, features, constraints, instruction formats, source evidence and build progress. Automatic discovery prepares up to three devices concurrently, including resumed jobs, and waits for the batch before marking discovery complete. Per-device locks prevent duplicate integration across server processes. Startup checks persisted completion and pending work, skips a finished catalog, and resumes an interrupted build on launch or the next authenticated request; API keys are never stored in catalog rows.
- **Initial scope.** Automatic discovery verifies that liquid handling is the device’s primary function before preparing its workspace; older queued candidates outside this scope are skipped. It targets 50 programmable liquid-handler models by default, across manufacturers and liquid-handling applications, without a fixed brand/model list. `BIOBOT_CATALOG_INITIAL_LIMIT` changes this initial batch size (`0` searches until no additional models are found). This is a growing catalog, not a claim to exhaustively list every instrument. Other types of biology devices are added only on request, after checking programmability and retrieving their documentation. Set `BIOBOT_CATALOG_ENABLED=0` to disable the automatic inventory build while retaining on-demand discovery.

### Device documentation
The book icon beside the workspace device name opens existing manuals and API references in a separate panel. Users can search document names and extracted text, read a text preview, download originals and follow recorded source links. Preparation progress refreshes while indexing is active. Opening documentation makes no AI requests. Saved protocol code and internal indexes are excluded from the shared files.

### Device search on the landing page
While the configured liquid-handler discovery cycle is incomplete, the home page shows preparation progress and opens automatically when discovery finishes. Administration remains accessible to approved administrators, including during catalog resets.

The landing page asks **On what device?** above a slim, single-line textbox.
Typing filters all matching exact models in one dropdown at the textbox's width,
without family drill-downs or API calls per keystroke. Search uses names and
source-backed capability descriptions across manufacturers; Enter can discover
additional matching physical models online. Categories do not restrict visibility.

Choosing a model attaches it to the textbox as an editable device chip and changes
the title to **What protocol would you like to prepare?** Device verification,
workspace preparation and documentation indexing start in the background while
the user writes. Clicking the attachment changes the device while preserving the
protocol draft. The chat opens only when the protocol description is submitted.
That prompt is saved immediately, and generation waits for the selected device
if it is still preparing. A pending preparation and the resulting protocol reuse
the same private chat rather than creating duplicates.

Every physical model remains independently selectable even when documented models
share a programming engine. Manufacturer sources must establish compatible APIs
and protocol formats before BioBot learns a shared programming series; shared
languages, names or file extensions alone are insufficient. Learned grouping
metadata stays outside source control in `biobot/data/device_series.json`.
Hardware, consumables and physical limits remain model-specific. A discovered
family is offered as exact models instead of an error or an executable device. Family checks include documented hardware and suffix variants even when only a few models are saved; fresh verified choices enrich later suggestions without registering devices until selected. Downloaded source pages and embeddings are shared across models, while their physical identities and limits remain separate. Before fetching new documentation, BioBot reuses matching cached sources and public manuals from source-verified programming-compatible peers. GitHub documentation crawls stay within one repository and exclude profiles, pull requests and issue discussions.

Temporary AI timeouts retry within the same background chat task, with progress notices rather than an immediate error answer. Deck preparation retries reuse the generated protocol. Retries are bounded, remain cancellable, and preserve quota enforcement.

History and account tools open from the top-right icons. History keeps background
preparations and shows unread completion counts, including failures. Protocol tasks
finish only after their deck, parameters and playback are prepared and saved.
Transient discovery and layout API failures are retried twice; failed attempts
preserve completed work and report their cause. Chats and saved protocols use a
single header row for the home logo, chat name, playback and actions. The inspector
starts hidden and overlays the deck without resizing its items, the chat textbox stays on one line, and the funding note remains at
the bottom without a divider.

Device discovery progress is available with `docker compose logs -f biobot`: search rounds, queued and verified devices, workspace preparation, readiness with elapsed time, and failures.

### Administration
Set `BIOBOT_ADMINS` to the server owners' comma-separated email addresses, then use the shield button in the account menu to open the dedicated `/admin` workspace. Its interface is separate from protocol chat, with Users and Devices sections. The User/Admin switch returns to the regular workspace. Approved administrators also have access.

From the command line, grant access to an existing account with `./grant-admin.sh you@example.com`. No restart is needed. The script uses the configured Docker database and records the change in the administrator audit log.

- **Users tab:** review access requests and edit names, email, job role, country and administrator access. Password resets require a new password, revoke existing sessions and clear the password-encrypted API key; chats and protocols remain saved. Server owner addresses cannot be reassigned through this view.
- **Devices tab:** search a flat list of the local inventory and edit features, constraints (with scope, units, increments, bounds and optional validation formulas), instruction language/format, extension, programming interface and physical workspace geometry. The list refreshes every three seconds while the Devices tab is visible, preserving search and unsaved edits. For example, an increment of `2.5` with unit `nL` remains explicit rather than being silently treated as microlitres.
- **Deck editing in Devices:** search the device list to find a saved device; its capabilities and physical deck appear together. Edit device and Edit deck are independent pressed/unpressed toggles; hiding either editor preserves its unsaved draft. Inspect its physical map, edit position IDs, coordinates, dimensions, hardware labels and fixed components, or add/remove positions. Spatial components can be dragged. Saved ordinal layouts can be converted to explicitly relative coordinate geometry. Save updates the shared default while preserving private copies and instruction profiles; discard restores the saved draft. Existing track positions remain visible even when no carriers are loaded.
- **Update (Devices tab):** checks existing instruments against primary online sources, refreshes profiles without changing saved deck geometry, and searches for additional programmable models. Administrator-edited profiles retain their corrections while new source references are appended. Existing ready devices stay usable when an online check fails, with errors reported for retry. Each update can discover up to `BIOBOT_CATALOG_INITIAL_LIMIT` additional instruments (default 50; 0 means no cap), even after the initial inventory limit has been reached. Update uses the configured or signed-in user API key and shows progress.
- **RESET DB (Devices tab):** confirms removal of all devices, aliases, learned profiles, hardware catalogs, cached series and default shared decks, then starts discovery again from scratch. Users, chats, saved protocols and personal decks are preserved; protocols using a shared default retain a private layout snapshot. During active discovery or editing, the list clears immediately and the reset waits for the current work to drain before flushing storage. The reset request survives restarts. Active protocol preparation blocks an immediate reset to protect saved work. The fresh discovery has live progress and the reset is recorded in the administrator audit log. An explicit reset starts discovery even when automatic startup discovery is disabled.
- **Reset from sources:** queues fresh verification, instruction discovery and default workspace generation for that device. It replaces administrator corrections after discovery succeeds, retains personal layout copies and saved protocols, and keeps the previous default geometry until the replacement is ready. Active builders cannot be edited or reset concurrently. Administrators can refresh the device list to follow progress.
- **Runtime corrections:** saved profile changes inform future protocol generation and export. Explicit simulator formulas are carried into structured protocol validation; descriptive constraints without formulas inform generation. Administrator mutations require a session token and are recorded in `admin_audit` without passwords or API keys.

### Model settings

In **Administration → Models**, select the model for each task. The Documentation
model defaults to `gpt-6.2-sol`. Existing explicit administrator selections are
preserved. Automatic updates are off by default and can be enabled separately for
Main, Light and Documentation:

- **Off:** keep the selected model.
- **Same price or cheaper:** choose a newer model in the same class only when
  input, output and published cached-input rates do not increase. Equal prices
  are eligible. Missing prices keep the current model.
- **Regardless of price:** choose the newest eligible model in the same class.

Updates run after the daily catalog refresh or **Refresh models and prices**.
Only models available to the installation's API key and documented as stable are
eligible. Main and Documentation require web-search support. Named model classes
stay separate; renamed equivalents need official documentation establishing the
same class. Automatic changes are recorded in the administrator audit log. A
failed catalog lookup leaves selections unchanged. The price comparison uses
Standard token rates, rather than estimating total workload or tool costs.

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

Administrators can change the shared API key’s **daily allowance per user** in **Admin → Users → Edit user** (default **$0.50 USD**, **0** disables the protocol allowance, **Unlimited** removes the cap). **Recharge quota** adds a chosen amount for today only, expiring at **00:00 UTC**, without changing the daily limit or erasing usage history. The daily allowance also resets at **00:00 UTC**. Personal API keys and shared device setup are excluded. Device identification, family discovery, workspace creation, hardware catalogs, documentation downloads and document indexing never consume a user’s daily allowance, even when that allowance is exhausted. Protocol design, edits and code generation reserve allowance before API calls; completed calls are charged using reported tokens and web-search fees. Search content costs are estimated before completion, so an in-flight call may exceed the remaining allowance. Interrupted calls conservatively keep their reservation for the day. Models need published prices in the admin catalog when a finite allowance applies.
