# Keycloak SSO Setup for Paperclip

This document describes how to set up Keycloak SSO for Paperclip.

## 1. Deploy Keycloak

Use the provided docker-compose setup in `docker/keycloak/`:

```bash
cd docker/keycloak
docker-compose up -d
```

Keycloak will be available at `http://localhost:8080`.
The default admin credentials are `admin/admin`.

## 2. Configure Keycloak

The `realm.json` file is automatically imported on startup.
It creates:
- Realm: `paperclip`
- Client: `paperclip-client` (Secret: `paperclip-secret`)
- User: `user` (Password: `password`)

## 3. Configure Paperclip

Update your Paperclip environment variables:

```env
PAPERCLIP_DEPLOYMENT_MODE=authenticated
BETTER_AUTH_SECRET=a-very-secret-key
BETTER_AUTH_URL=http://localhost:3100
AUTH_OIDC_ISSUER=http://localhost:8080/realms/paperclip
AUTH_OIDC_CLIENT_ID=paperclip-client
AUTH_OIDC_CLIENT_SECRET=paperclip-secret
```

## 4. Reverse Proxy (Nginx)

In a production deployment, both Keycloak and Paperclip should be behind a reverse proxy (e.g., Nginx) with SSL.

Example Nginx configuration (simplified):

```nginx
server {
    listen 443 ssl;
    server_name paperclip.example.com;

    location / {
        proxy_pass http://paperclip:3100;
        # ... standard proxy headers
    }

    location /auth/ {
        proxy_pass http://keycloak:8080/;
        # ... standard proxy headers
    }
}
```
