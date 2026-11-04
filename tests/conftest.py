"""Tests never read the repo's .env.local: a saved Grok key must not turn an offline test into a live call."""

import os

os.environ["BRC_OFFLINE"] = "1"
