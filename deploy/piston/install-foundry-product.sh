#!/bin/bash
set -euo pipefail

target=/piston/packages/foundry-product/1.0.0
mkdir -p "$target"
cp /opt/foundry/product-runtime.js "$target/product-runtime.js"
printf '%s\n' '{"language":"foundry-product","version":"1.0.0","aliases":["foundry-product-v1"],"build_platform":"docker-debian","limit_overrides":{"run_timeout":180000,"run_cpu_time":180000,"run_memory_limit":536870912,"max_process_count":128,"max_open_files":512,"max_file_size":134217728,"output_max_size":16777216}}' >"$target/pkg-info.json"
printf '%s\n' 'export PATH=/usr/local/cargo/bin:/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin' 'export CARGO_HOME=/usr/local/cargo' 'export RUSTUP_HOME=/usr/local/rustup' >"$target/environment"
printf '%s\n' 'PATH=/usr/local/cargo/bin:/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin' 'CARGO_HOME=/usr/local/cargo' 'RUSTUP_HOME=/usr/local/rustup' >"$target/.env"
printf '%s\n' '#!/bin/bash' 'exec /usr/local/bin/node /piston/packages/foundry-product/1.0.0/product-runtime.js "$@"' >"$target/run"
touch "$target/.ppman-installed"
chmod 755 "$target/run" "$target/product-runtime.js"
