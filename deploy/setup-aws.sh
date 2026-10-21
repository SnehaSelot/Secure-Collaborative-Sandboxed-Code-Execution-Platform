#!/usr/bin/env bash
# =============================================================================
# GlassHouse — AWS EC2 Bootstrap Script (Ubuntu 24.04 LTS)
# =============================================================================
# Run this script as: sudo bash setup-aws.sh
#
# What it does:
#   1. Installs system packages (Docker, PostgreSQL, Nginx, Python, Node.js)
#   2. Creates a 2 GB swap file (OOM protection for t3.micro)
#   3. Creates the 'glasshouse' system user
#   4. Sets up the PostgreSQL database
#   5. Creates a Python venv and installs backend dependencies
#   6. Builds the frontend
#   7. Deploys Nginx config for the frontend SPA
#   8. Installs the systemd service for the backend
#   9. Pulls Docker sandbox images (this takes a while!)
#  10. Starts all services
#
# Prerequisites:
#   - Ubuntu 24.04 LTS EC2 instance
#   - Project cloned/uploaded to /opt/glasshouse
#   - You have already filled in /opt/glasshouse/backend/.env
#     (copy from deploy/server.env.template and replace placeholders)
#
# This script does NOT create any AWS resources or incur charges.
# =============================================================================
set -euo pipefail

PROJECT_DIR="/opt/glasshouse"
VENV_DIR="${PROJECT_DIR}/venv"
FRONTEND_DIST="/var/www/glasshouse"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; }

# ---------------------------------------------------------------------------
# 0. Pre-flight checks
# ---------------------------------------------------------------------------
if [ "$(id -u)" -ne 0 ]; then
    error "This script must be run as root (sudo bash setup-aws.sh)"
    exit 1
fi

if [ ! -d "${PROJECT_DIR}/backend" ]; then
    error "Project not found at ${PROJECT_DIR}."
    echo "  Clone your repo first:"
    echo "    sudo mkdir -p ${PROJECT_DIR}"
    echo "    sudo chown ubuntu:ubuntu ${PROJECT_DIR}"
    echo "    git clone <YOUR_REPO_URL> ${PROJECT_DIR}"
    exit 1
fi

if [ ! -f "${PROJECT_DIR}/backend/.env" ]; then
    error "Backend .env not found!"
    echo "  Copy the template and fill in the values:"
    echo "    cp ${PROJECT_DIR}/deploy/server.env.template ${PROJECT_DIR}/backend/.env"
    echo "    nano ${PROJECT_DIR}/backend/.env"
    exit 1
fi

info "Pre-flight checks passed ✓"

# ---------------------------------------------------------------------------
# 1. System update + packages
# ---------------------------------------------------------------------------
info "Updating system packages..."
apt-get update -y
apt-get upgrade -y

info "Installing core dependencies..."
apt-get install -y \
    docker.io \
    postgresql postgresql-contrib \
    nginx \
    python3 python3-venv python3-pip \
    git curl build-essential libpq-dev

# Node.js 22.x (for building the frontend)
if ! command -v node &> /dev/null; then
    info "Installing Node.js 22.x..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
fi

info "System packages installed ✓"

# ---------------------------------------------------------------------------
# 2. Swap space (2 GB — critical for t3.micro with 1 GB RAM)
# ---------------------------------------------------------------------------
if [ ! -f /swapfile ]; then
    info "Creating 2 GB swap file..."
    dd if=/dev/zero of=/swapfile bs=1M count=2048
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    echo '/swapfile swap swap defaults 0 0' >> /etc/fstab
    info "Swap configured ✓"
else
    info "Swap already exists, skipping."
fi

# ---------------------------------------------------------------------------
# 3. Create 'glasshouse' system user
# ---------------------------------------------------------------------------
if ! id -u glasshouse &>/dev/null; then
    info "Creating 'glasshouse' system user..."
    useradd --system --create-home --shell /bin/bash glasshouse
fi
usermod -aG docker glasshouse
info "User 'glasshouse' ready ✓"

# ---------------------------------------------------------------------------
# 4. Docker setup
# ---------------------------------------------------------------------------
info "Enabling Docker..."
systemctl enable --now docker

# ---------------------------------------------------------------------------
# 5. PostgreSQL setup
# ---------------------------------------------------------------------------
info "Setting up PostgreSQL..."
systemctl enable --now postgresql

# Generate a random DB password
DB_PASS=$(python3 -c "import secrets; print(secrets.token_urlsafe(24))")

# Create user and database (idempotent)
sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='glasshouse'" \
    | grep -q 1 || sudo -u postgres psql -c "CREATE USER glasshouse WITH PASSWORD '${DB_PASS}';"

sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='glasshouse_db'" \
    | grep -q 1 || sudo -u postgres createdb glasshouse_db -O glasshouse

# Load the schema
sudo -u postgres psql -d glasshouse_db -f "${PROJECT_DIR}/backend/schema.sql" 2>/dev/null || true

# Apply migrations
for migration in "${PROJECT_DIR}"/backend/migrations/*.sql; do
    if [ -f "$migration" ]; then
        info "  Applying migration: $(basename "$migration")"
        sudo -u postgres psql -d glasshouse_db -f "$migration" 2>/dev/null || true
    fi
done

# Update pg_hba.conf to allow local password auth
PG_HBA=$(sudo -u postgres psql -t -c "SHOW hba_file;" | tr -d '[:space:]')
if ! grep -q 'glasshouse' "$PG_HBA" 2>/dev/null; then
    # Add password auth line for the glasshouse user BEFORE the default peer line
    sed -i '/^local.*all.*all.*peer/i local   glasshouse_db   glasshouse                              md5' "$PG_HBA"
    # Also allow TCP connections from localhost
    sed -i '/^host.*all.*all.*127.0.0.1/i host    glasshouse_db   glasshouse      127.0.0.1/32        md5' "$PG_HBA"
    systemctl reload postgresql
fi

info "PostgreSQL configured ✓"
info "  Database: glasshouse_db"
info "  User:     glasshouse"
info "  Password: ${DB_PASS}"
warn ">>> UPDATE backend/.env with this DATABASE_URL:"
warn "    DATABASE_URL=postgresql+asyncpg://glasshouse:${DB_PASS}@localhost:5432/glasshouse_db"

# ---------------------------------------------------------------------------
# 6. Generate JWT secret and update .env if still placeholder
# ---------------------------------------------------------------------------
JWT_SECRET=$(python3 -c "import secrets; print(secrets.token_hex(32))")
if grep -q '<GENERATED_JWT_SECRET>' "${PROJECT_DIR}/backend/.env"; then
    sed -i "s/<GENERATED_JWT_SECRET>/${JWT_SECRET}/" "${PROJECT_DIR}/backend/.env"
    info "JWT secret auto-generated and written to .env ✓"
fi
if grep -q '<DB_PASSWORD>' "${PROJECT_DIR}/backend/.env"; then
    sed -i "s/<DB_PASSWORD>/${DB_PASS}/" "${PROJECT_DIR}/backend/.env"
    info "DB password auto-written to .env ✓"
fi

# ---------------------------------------------------------------------------
# 7. Python venv + backend dependencies
# ---------------------------------------------------------------------------
info "Creating Python virtual environment..."
python3 -m venv "${VENV_DIR}"
"${VENV_DIR}/bin/pip" install --upgrade pip
"${VENV_DIR}/bin/pip" install -r "${PROJECT_DIR}/backend/requirements.txt"
info "Python dependencies installed ✓"

# ---------------------------------------------------------------------------
# 8. Build frontend
# ---------------------------------------------------------------------------
info "Building frontend..."
cd "${PROJECT_DIR}/frontend"
npm ci
npm run build
mkdir -p "${FRONTEND_DIST}"
cp -r dist/* "${FRONTEND_DIST}/"
info "Frontend built and deployed to ${FRONTEND_DIST} ✓"

# ---------------------------------------------------------------------------
# 9. Nginx configuration
# ---------------------------------------------------------------------------
info "Configuring Nginx..."
cp "${PROJECT_DIR}/deploy/glasshouse.conf" /etc/nginx/sites-available/glasshouse
ln -sf /etc/nginx/sites-available/glasshouse /etc/nginx/sites-enabled/glasshouse
rm -f /etc/nginx/sites-enabled/default  # Remove default welcome page
nginx -t
systemctl enable --now nginx
systemctl reload nginx
info "Nginx configured ✓"

# ---------------------------------------------------------------------------
# 10. Directory permissions
# ---------------------------------------------------------------------------
info "Setting permissions..."
mkdir -p "${PROJECT_DIR}/backend/exec_tmp"
mkdir -p "${PROJECT_DIR}/backend/profile_uploads"
chown -R glasshouse:glasshouse "${PROJECT_DIR}"
info "Permissions set ✓"

# ---------------------------------------------------------------------------
# 11. Systemd service for the backend
# ---------------------------------------------------------------------------
info "Installing systemd service..."
cp "${PROJECT_DIR}/deploy/glasshouse-api.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable glasshouse-api
systemctl start glasshouse-api
info "Backend service started ✓"

# ---------------------------------------------------------------------------
# 12. Pull Docker sandbox images (LARGEST step — ~4 GB download)
# ---------------------------------------------------------------------------
info "Pulling Docker sandbox images (this may take 5-15 minutes)..."
IMAGES=(
    "python:3.12-slim"
    "node:22-alpine"
    "eclipse-temurin:21-jdk"
    "gcc:14"
    "golang:1.24-alpine"
    "rust:1.88-slim"
)
for img in "${IMAGES[@]}"; do
    info "  Pulling ${img}..."
    docker pull "${img}"
done
info "All sandbox images pulled ✓"

# ---------------------------------------------------------------------------
# Done!
# ---------------------------------------------------------------------------
echo ""
echo "============================================="
echo -e "${GREEN}  GlassHouse deployment complete! 🎉${NC}"
echo "============================================="
echo ""
ELASTIC_IP=$(curl -s http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || echo "<YOUR_ELASTIC_IP>")
echo "  Frontend:  http://${ELASTIC_IP}/"
echo "  Backend:   http://${ELASTIC_IP}:8000/"
echo "  API Docs:  http://${ELASTIC_IP}:8000/docs"
echo ""
echo "  Check backend logs:  journalctl -u glasshouse-api -f"
echo "  Restart backend:     sudo systemctl restart glasshouse-api"
echo "  Restart Nginx:       sudo systemctl restart nginx"
echo ""
echo "  DB Password: ${DB_PASS}"
echo "  (save this somewhere safe!)"
echo ""

