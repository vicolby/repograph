# AGENTS.md

## Docker on this machine

The shell has no direct access to `/var/run/docker.sock` (`permission
denied`), even though the `docker` binary and socket exist. Run every
docker-dependent command through the `docker` group:

```bash
sg docker -c 'npm test'
sg docker -c 'docker compose up -d'
```
