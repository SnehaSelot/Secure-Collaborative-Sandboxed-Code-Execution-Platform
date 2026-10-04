"""
app/core/docker_client.py — Shared Docker client singleton.

Provides get_docker_client() and the module-level _docker_client global.
All other modules that need a Docker client import from here.
"""

import docker

_docker_client = None


def get_docker_client() -> docker.DockerClient:
    global _docker_client
    if _docker_client is None:
        _docker_client = docker.from_env()
    return _docker_client
