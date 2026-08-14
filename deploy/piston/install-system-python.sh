#!/bin/bash
set -euo pipefail

version="$(python3 --version | awk '{print $2}')"
minor="${version%.*}"
target="/piston/packages/python/$version"
mkdir -p "$target"
printf '{"language":"python","version":"%s","aliases":["py","py3","python3","python%s"],"build_platform":"docker-debian"}\n' "$version" "$minor" >"$target/pkg-info.json"
printf 'export PATH=/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin:.\n' >"$target/environment"
printf 'PATH=/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin:.\n' >"$target/.env"
printf '#!/bin/bash\n\n/usr/bin/python3 "$@"\n' >"$target/run"
touch "$target/.ppman-installed"
chmod 755 "$target/run"
