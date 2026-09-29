"""Development bots for the local LiveKit of compose.yaml (roadmap slice 0a): `just bots N`.

Each bot creates its media room through the server API when it is missing, joins with a dev
token and publishes a tone and a test picture. Joining through `join`, with a token from the
backend, arrives in slice 1; the scenario of moving between rooms in slice 2.

`just echo-check` (bots/echo_check.py) runs one bot with a speech-like voice for the echo check.
"""
