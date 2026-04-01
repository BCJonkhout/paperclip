#!/bin/bash
set -e

echo "Starting Auth Flow Verification..."

# 1. Check if Keycloak is reachable
echo "Checking Keycloak reachability..."
# We assume Keycloak is running at http://localhost:8080 based on our deployment plan
if curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/realms/paperclip/.well-known/openid-configuration | grep -q "200"; then
    echo "PASS: Keycloak realm 'paperclip' is reachable and configured."
else
    echo "FAIL: Keycloak realm 'paperclip' is NOT reachable. Ensure docker/keycloak is running."
    # exit 1 # Don't exit yet so we can see other checks
fi

# 2. Check if Paperclip is reachable through Nginx
echo "Checking Nginx reverse proxy..."
if curl -s -o /dev/null -w "%{http_code}" http://localhost/ | grep -q "200"; then
    echo "PASS: Nginx is proxying to Paperclip."
else
    echo "FAIL: Nginx is NOT proxying to Paperclip correctly."
fi

# 3. Check Paperclip Auth Config
echo "Checking Paperclip Auth Configuration..."
# This would normally check if the environment variables are correctly set in the running container
# For now we just check the .env file if it exists
if [ -f .env ]; then
    if grep -q "AUTH_OIDC_ISSUER" .env; then
        echo "PASS: .env contains OIDC configuration."
    else
        echo "FAIL: .env is missing OIDC configuration."
    fi
else
    echo "SKIP: .env file not found in current directory."
fi

echo "Auth Flow Verification Complete."
