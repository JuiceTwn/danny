#!/bin/sh
# Runs once, the first time the database volume is created.
# danny_owner owns the tables and runs migrations. danny_app is what the API runs as,
# and it is the role that row-level security applies to.
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
CREATE ROLE danny_owner LOGIN PASSWORD '${DANNY_OWNER_PASSWORD}';
CREATE ROLE danny_app LOGIN PASSWORD '${DANNY_APP_PASSWORD}';
ALTER DATABASE ${POSTGRES_DB} OWNER TO danny_owner;
GRANT CONNECT ON DATABASE ${POSTGRES_DB} TO danny_app;
SQL
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -c "GRANT ALL ON SCHEMA public TO danny_owner; GRANT USAGE ON SCHEMA public TO danny_app;"
