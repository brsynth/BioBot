# CHANGELOG

<!-- version list -->

## v1.1.0 (2026-09-03)

### Bug Fixes

- **docker**: Use CMD-SHELL for postgres healthcheck
  ([`d6588b7`](https://github.com/brsynth/BioBot/commit/d6588b77b8084d9d69b72192adc5ec8a74267074))

### Chores

- Add multiple actions for cli usage
  ([`02d8a73`](https://github.com/brsynth/BioBot/commit/02d8a73735ee062c34949d288e805c6554ffcd66))

- **encryption_salt**: Handle the case where it is null
  ([`2e53ed6`](https://github.com/brsynth/BioBot/commit/2e53ed6c5204519b3105e11615ad8dd39db5a14c))

- **output type**: Optimize generated file detection
  ([`18874ae`](https://github.com/brsynth/BioBot/commit/18874ae81c53dbdfb88baafac366bc4943ec03bb))

- **rag**: Optimize validation by llm review step
  ([`eb9f467`](https://github.com/brsynth/BioBot/commit/eb9f4674c9d37acb29972f90c49e7899d9c27925))

### Code Style

- **auth**: Add auth-description class for helper text
  ([`558b511`](https://github.com/brsynth/BioBot/commit/558b511e6cb789857c87e39b29776c0814572270))

- **deck**: Add deck visualizer panel styles
  ([`fdd94bb`](https://github.com/brsynth/BioBot/commit/fdd94bb16c5a3d2480fa1dfacc5c072e3cceb631))

- **questions**: Add styling stepper questions UI
  ([`ae1abd2`](https://github.com/brsynth/BioBot/commit/ae1abd27d23ade2319b800f95e4aa9d6def9716e))

### Features

- Add routes for deck visualization and code feedback endpoints
  ([`62902d4`](https://github.com/brsynth/BioBot/commit/62902d403ab33988ce394cde1623e6e57ebf3604))

- Update app encryption and deck routes
  ([`6ffe8a1`](https://github.com/brsynth/BioBot/commit/6ffe8a13e0f853c31e6f20de3df80ab52a73531a))

- **auth**: Add email service for password reset
  ([`eecf0ff`](https://github.com/brsynth/BioBot/commit/eecf0ff011c4ecab95a93a0fe3980eca9b58880d))

- **auth**: Add forgot password link to login page
  ([`c4dbb22`](https://github.com/brsynth/BioBot/commit/c4dbb225345807921cc9b97bcfc97e584313489c))

- **auth**: Add forgot password page
  ([`ec1807b`](https://github.com/brsynth/BioBot/commit/ec1807b2adc434a7a0bd0f493b2238b762af75ba))

- **auth**: Add reset password page
  ([`58d23eb`](https://github.com/brsynth/BioBot/commit/58d23eb2a5ee9eccadf0e75d6945a0777935cbab))

- **chat**: Add code feedback actions, deck button, and structured questions UI
  ([`c6f4e8a`](https://github.com/brsynth/BioBot/commit/c6f4e8a50a33a6a4254b622213ea35a56463e882))

- **db**: Add password reset tokens table
  ([`9e7486a`](https://github.com/brsynth/BioBot/commit/9e7486a810692ff1c0a7bddc02b4583e108cc830))

- **deck**: Add coherence validation for deck edits
  ([`4dc8622`](https://github.com/brsynth/BioBot/commit/4dc8622ccdc47a75debd6679275614bd53354256))

- **deck**: Add editable parameter panel for protocol values
  ([`0bfeb0a`](https://github.com/brsynth/BioBot/commit/0bfeb0af15a354948b7b8777803c4dbba6e85b37))

- **deck**: Add interactive deck renderer
  ([`79364fb`](https://github.com/brsynth/BioBot/commit/79364fb980184769621395f2f6ba696f79110ed8))

- **deck**: Add interactive deck renderer with drag-and-drop
  ([`133e80b`](https://github.com/brsynth/BioBot/commit/133e80bb5d334cd6574e5ed720d61cf2062f38fc))

- **deck**: Add multi-platform protocol parser
  ([`0aab2c8`](https://github.com/brsynth/BioBot/commit/0aab2c8338b6f55ace1dc9f00402c11b376296cf))

- **questions**: Add style stepper UI for sufficiency-check questions
  ([`37645f0`](https://github.com/brsynth/BioBot/commit/37645f09744b80c3c17394873bdbc0b7ed171069))

- **rag**: Emit structured questions from sufficiency check
  ([`8d73518`](https://github.com/brsynth/BioBot/commit/8d7351814bdc5d9da962bb3060123ed21c75eca1))

- **ui**: Wire up deck panel and structured questions to index page
  ([`24387bf`](https://github.com/brsynth/BioBot/commit/24387bf1e3b9fa74dd51ce4fa4a58c9d89215e48))

### Refactoring

- **engine**: Stream structured questions
  ([`db4e7db`](https://github.com/brsynth/BioBot/commit/db4e7db01b80258ffa95f3a3fbe1500ed7d1c378))


## v1.0.2 (2026-04-15)

### Bug Fixes

- **ngnx**: Disable nginx buffering
  ([`c6926ec`](https://github.com/brsynth/BioBot/commit/c6926ec4871cda6682714ee18eed75b4dbc2aaba))

### Chores

- **decryption**: Handle silent decryption's fails
  ([`4bae4c9`](https://github.com/brsynth/BioBot/commit/4bae4c96bf92612e4f1d269ae099782adf39ff16))

- **gunicorn**: Add threaded workers
  ([`a4985fb`](https://github.com/brsynth/BioBot/commit/a4985fb7c3a79fd26ca78f04e94f1ee64780399e))

- **output**: Add additional step for code block detection
  ([`d6a270a`](https://github.com/brsynth/BioBot/commit/d6a270a4a7d56f8fffcc7be42772fa7bbbff5e8b))

- **output**: Handle new output file format for protocol generation
  ([`6ced33c`](https://github.com/brsynth/BioBot/commit/6ced33c6fe416cd13800b85c02343d5a41d18590))

- **prompt**: Edit system prompts for more accuracy
  ([`e620bf2`](https://github.com/brsynth/BioBot/commit/e620bf28159e3ab197807bb11f38608cd12d80da))


## v1.0.1 (2026-03-31)

### Bug Fixes

- **chat-stream**: Handle exceptions during streaming and DB save to prevent corrupted HTTP
  responses
  ([`8dfff82`](https://github.com/brsynth/BioBot/commit/8dfff82c840478bae8ee8f87f54cb8b3d3bc447c))

### Chores

- Docker compose modified for project's structure change
  ([`b6d4ab5`](https://github.com/brsynth/BioBot/commit/b6d4ab5c84c40882a8f1acfae8c176083334984b))

- Move venv to gitignore
  ([`80c9eae`](https://github.com/brsynth/BioBot/commit/80c9eae515e872c4668c3445dd3f966df0fdc97e))

- **cli**: Add command-line interface for app usage
  ([`c3f9ecb`](https://github.com/brsynth/BioBot/commit/c3f9ecb9a83dab6035076987a789a8ae25b1608d))

- **model**: Change model gpt-5 to gpt-5.4
  ([`23ca132`](https://github.com/brsynth/BioBot/commit/23ca132a12c68dd521a93636a45fd4a747f36846))

- **version**: Add version
  ([`722c367`](https://github.com/brsynth/BioBot/commit/722c36796ecf7e6824baba18ef0e450e80c2030c))

- **version**: Move version next to logo
  ([`e1fbdc0`](https://github.com/brsynth/BioBot/commit/e1fbdc06ce12a51fb6afc35dfdb57f90da4511e6))

### Refactoring

- **docker files**: Change structure by moving requirements and dockerfile to root dir
  ([`480d54a`](https://github.com/brsynth/BioBot/commit/480d54a6be23d47cad3dd85a056cb6ec1a9a6838))

- **project-structure**: Reorganize source code layout and move files to root
  ([`7ed574c`](https://github.com/brsynth/BioBot/commit/7ed574c600299c4baa6083c24de6cd7e1c3853f4))


## v1.0.0 (2026-03-26)

- Initial Release
