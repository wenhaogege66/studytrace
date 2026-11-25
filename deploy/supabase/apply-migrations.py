"""Apply checksum-tracked migrations to the private StudyTrace test backend."""

import argparse
import hashlib
import os
from pathlib import Path
import re
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("phase", choices=("regular", "cutover"))
args = parser.parse_args()
root = Path(__file__).resolve().parents[2]
target_file = Path.home() / ".config/studytrace/ssh-target"
target = os.environ.get("STUDYTRACE_SSH_TARGET") or (
    target_file.read_text().strip() if target_file.exists() else ""
)
if not target or target.startswith("-") or any(c.isspace() for c in target):
    raise SystemExit("Set STUDYTRACE_SSH_TARGET or ~/.config/studytrace/ssh-target.")
remote = [
    "ssh", "-o", "BatchMode=yes", target,
    'cd "$HOME/studytrace/backend" && docker compose exec -T db psql -U postgres -d postgres -v ON_ERROR_STOP=1',
]
cutover = "20260907153524_revoke_direct_study_session_writes.sql"


def sql(statement):
    result = subprocess.run(remote, input=statement, text=True, capture_output=True)
    if result.returncode:
        raise SystemExit(result.stderr)
    return result.stdout


sql("""
create schema if not exists studytrace_deploy;
create table if not exists studytrace_deploy.migrations (
    version text primary key,
    sha256 text not null,
    applied_at timestamptz not null default now()
);
""")
for source in sorted((root / "supabase/migrations").glob("*.sql")):
    if (source.name == cutover) != (args.phase == "cutover"):
        continue
    if not re.fullmatch(r"[0-9]{14}_[a-z_]+\.sql", source.name):
        raise SystemExit(f"Invalid migration filename: {source.name}")
    checksum = hashlib.sha256(source.read_bytes()).hexdigest()
    prior = sql(
        f"select sha256 from studytrace_deploy.migrations where version='{source.name}';"
    )
    existing = re.findall(r"\b[0-9a-f]{64}\b", prior)
    if existing:
        if existing != [checksum]:
            raise SystemExit(f"Applied migration changed: {source.name}")
        print("Already applied:", source.name)
        continue
    sql(
        f"begin;\n{source.read_text()}\n"
        f"insert into studytrace_deploy.migrations(version,sha256) "
        f"values ('{source.name}','{checksum}');\ncommit;"
    )
    print("Applied:", source.name, checksum)
