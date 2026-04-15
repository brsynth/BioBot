# CHANGELOG

<!-- version list -->

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
