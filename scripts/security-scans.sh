#!/usr/bin/env bash
# Runs the security scans for this project and saves the reports in security-reports/:
#   ./scripts/security-scans.sh
# Needs AWS credentials for the deploy account (the stack looks up the S3 prefix list at synth)
# and, for the image scans, Docker with buildx.
set -uo pipefail

# Scan tools are pinned so the reports are reproducible. Bump these when you refresh the run.
CDK_NAG_VERSION=2.38.2
RETIRE_VERSION=6.1.0
TRIVY_VERSION=0.76.0
PIP_AUDIT_VERSION=2.10.1

cd "$(dirname "$0")/.."
export AWS_REGION=us-east-1
out="$PWD/security-reports"
rm -rf "$out"
mkdir -p "$out"

# The stack resolves the S3 prefix list at synth, so it needs the account. Use the active
# credentials; without them, fall back to the account cached in infra/cdk.context.json (the
# cached lookups make the synth work offline).
if account=$(aws sts get-caller-identity --query Account --output text 2>/dev/null); then
  echo "AWS account (active credentials): $account"
else
  account=$(sed -nE 's/.*"availability-zones:account=([0-9]{12}):region=us-east-1".*/\1/p' infra/cdk.context.json | head -1)
  if [ -z "$account" ]; then
    echo "No AWS credentials and no account in infra/cdk.context.json. Sign in to the deploy account and try again."
    exit 1
  fi
  echo "No active AWS credentials; using the account from cdk.context.json: $account"
fi
export CDK_DEFAULT_ACCOUNT="$account"
export CDK_DEFAULT_REGION="$AWS_REGION"

cd infra
npm ci --no-audit --no-fund
# cdk-nag is only needed for this scan, so it is installed (pinned) without changing package.json.
npm install --no-save --no-audit --no-fund "cdk-nag@${CDK_NAG_VERSION}"

# 1) cdk_nag (playground reached only through the SSM tunnel)
echo "== cdk_nag =="
npx cdk synth Laya -c nag=true -o cdk.out.nag --quiet > "$out/cdk-nag.log" 2>&1
echo "exit code: $?" >> "$out/cdk-nag.log"
cp cdk.out.nag/AwsSolutions-*-NagReport.csv "$out/cdk-nag.csv" 2>/dev/null || true
rm -rf cdk.out.nag

# 2) npm audit on the CDK dependencies
echo "== npm audit =="
npm audit --json > "$out/npm-audit.json" 2>/dev/null || true

# 3) Retire.js on the whole repo (scripts/ and infra/node_modules), pinned version
echo "== Retire.js =="
cd ..
npx --yes "retire@${RETIRE_VERSION}" --path . --outputformat json --outputpath "$out/retire-report.json" \
  > "$out/retire.log" 2>&1
echo "exit code: $? (13 = vulnerable libraries found)" >> "$out/retire.log"

# ---------------------------------------------------------------------------
# Container image scans. These build the two images locally and need Docker.
# ---------------------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  echo "Docker not found; skipping the Trivy and pip-audit image scans."
else
  # Trivy: download the pinned release archive into ./.tooling if trivy is not already on PATH,
  # and check it against the SHA-256 pinned below (from trivy_${TRIVY_VERSION}_checksums.txt in
  # the GitHub release) before extracting it. Update the hashes together with TRIVY_VERSION.
  if command -v trivy >/dev/null 2>&1; then
    TRIVY=trivy
  else
    case "$(uname -s)-$(uname -m)" in
      Linux-x86_64)               trivy_platform=Linux-64bit
                                  trivy_sha256=e24b1c51293c1b15e4ba8d45bbc7891ba053f90278ec2698f3562c993e145fe7 ;;
      Linux-aarch64|Linux-arm64)  trivy_platform=Linux-ARM64
                                  trivy_sha256=aab21e677a7b7071fc79f1711480840754c18a1b9d9cefa7ccd06af63a0e8f4c ;;
      Darwin-x86_64)              trivy_platform=macOS-64bit
                                  trivy_sha256=89563d4d495cf4ef06a0d1950f8710b124e9f7bd2615ec6c47b03673f4ad45a2 ;;
      Darwin-arm64)               trivy_platform=macOS-ARM64
                                  trivy_sha256=e7ec0d21fe842553f59af99aba2efbcc822369fbaed27019c575408b6d135fce ;;
      *) echo "No pinned Trivy ${TRIVY_VERSION} build for $(uname -s)-$(uname -m); install trivy on PATH."
         exit 1 ;;
    esac
    trivy_archive="trivy_${TRIVY_VERSION}_${trivy_platform}.tar.gz"
    echo "Installing Trivy ${TRIVY_VERSION} into ./.tooling ..."
    mkdir -p .tooling
    curl -sSfL -o ".tooling/${trivy_archive}" \
      "https://github.com/aquasecurity/trivy/releases/download/v${TRIVY_VERSION}/${trivy_archive}" \
      || { echo "Trivy download failed."; exit 1; }
    if command -v sha256sum >/dev/null 2>&1; then
      actual_sha256=$(sha256sum ".tooling/${trivy_archive}" | cut -d' ' -f1)
    else
      actual_sha256=$(shasum -a 256 ".tooling/${trivy_archive}" | cut -d' ' -f1)
    fi
    if [ "$actual_sha256" != "$trivy_sha256" ]; then
      echo "Checksum mismatch for ${trivy_archive}: expected ${trivy_sha256}, got ${actual_sha256}."
      rm -f ".tooling/${trivy_archive}"
      exit 1
    fi
    tar -xzf ".tooling/${trivy_archive}" -C .tooling trivy || { echo "Trivy extract failed."; exit 1; }
    rm -f ".tooling/${trivy_archive}"
    TRIVY="$PWD/.tooling/trivy"
  fi

  echo "== Building images for scanning =="
  docker buildx build --platform linux/amd64 --load -t laya-inference:scan ./laya-inference \
    > "$out/build-laya.log" 2>&1
  docker buildx build --platform linux/amd64 --load -t laya-playground:scan ./playground \
    > "$out/build-playground.log" 2>&1

  echo "== Trivy (images) =="
  for img in laya-inference:scan laya-playground:scan; do
    name=${img%%:*}
    "$TRIVY" image --severity HIGH,CRITICAL --format json --output "$out/trivy-${name}.json" "$img" \
      > "$out/trivy-${name}.log" 2>&1
    "$TRIVY" image --severity HIGH,CRITICAL --format table "$img" >> "$out/trivy-${name}.log" 2>&1
  done

  # pip-audit on the Python packages actually installed in each image. pip is removed from the
  # runtime images, so the installed list is read with importlib.metadata (the image's default
  # python resolves to the venv for laya-inference and to the system interpreter for playground),
  # then audited with the pinned pip-audit in a throwaway venv.
  echo "== pip-audit (image packages) =="
  python3 -m venv .tooling/pa-venv
  .tooling/pa-venv/bin/pip install --quiet --no-cache-dir "pip-audit==${PIP_AUDIT_VERSION}"
  for img in laya-inference:scan laya-playground:scan; do
    name=${img%%:*}
    docker run --rm --entrypoint python "$img" -c \
      'import importlib.metadata as m; print(chr(10).join(sorted("%s==%s" % (d.metadata["Name"], d.version) for d in m.distributions())))' \
      > "$out/freeze-${name}.txt" 2>/dev/null
    # --no-deps --disable-pip audits exactly the pinned versions in the freeze list without any
    # pip resolution, which would otherwise fail on the laya image's cuda-*/nvidia wheels (served
    # from pypi.nvidia.com, not PyPI). Both flags are needed: --no-deps alone still runs a pip
    # dry-run per requirement in pip-audit 2.10.1.
    .tooling/pa-venv/bin/pip-audit -r "$out/freeze-${name}.txt" --no-deps --disable-pip --format json \
      > "$out/pip-audit-${name}.json" 2> "$out/pip-audit-${name}.log" || true
  done
  rm -rf .tooling/pa-venv
fi

echo
echo "Reports in: $out"
ls -1 "$out"
