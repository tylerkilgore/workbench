#!/bin/sh
# Build the Workbook CLI from source and stage it for bundling.
#
# Workbench ships its own Workbook rather than requiring one to be installed, so
# this runs as part of every packaged build. It delegates to Workbook's own
# scripts/install.sh instead of invoking `go build` here, so the binary is
# stamped the way an official source install is: -trimpath, with version and
# commit derived from the checkout by `git describe`. Reimplementing that would
# drift from upstream the first time they changed it.
#
# The ref is pinned in package.json under "workbook", so a change upstream can
# never silently alter a Workbench release. Bump it deliberately.
#
#   WORKBOOK_REPO  use this checkout as-is instead of cloning (local development)
#   WORKBOOK_REF   override the pinned ref
#
# With no WORKBOOK_REPO — which is the case in CI — the pinned ref is cloned
# into build/workbook-src. A local checkout is used exactly as it stands,
# because reaching into someone's working tree to change its checked-out
# revision is not this script's business.

set -eu

script_directory=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
project_root=$(CDPATH='' cd -- "${script_directory}/.." && pwd)

if ! command -v go >/dev/null 2>&1; then
	echo "build-workbook: go is required to build Workbook from source." >&2
	echo "  macOS: brew install go" >&2
	exit 1
fi
if ! command -v node >/dev/null 2>&1; then
	echo "build-workbook: node is required to read the pinned ref." >&2
	exit 1
fi

pinned_url=$(node -p "require('${project_root}/package.json').workbook.repository")
pinned_ref=${WORKBOOK_REF:-$(node -p "require('${project_root}/package.json').workbook.ref")}

if [ -n "${WORKBOOK_REPO:-}" ]; then
	repo=${WORKBOOK_REPO}
	if [ ! -d "${repo}/.git" ]; then
		echo "build-workbook: WORKBOOK_REPO is not a git checkout: ${repo}" >&2
		exit 1
	fi
	echo "build-workbook: using local checkout ${repo} (ref pin ${pinned_ref} not applied)"
else
	repo="${project_root}/build/workbook-src"
	if [ ! -d "${repo}/.git" ]; then
		echo "build-workbook: cloning ${pinned_url}"
		mkdir -p -- "${project_root}/build"
		git clone --quiet "${pinned_url}" "${repo}"
	fi
	echo "build-workbook: checking out ${pinned_ref}"
	git -C "${repo}" fetch --quiet --tags origin
	git -C "${repo}" checkout --quiet --detach "${pinned_ref}"
fi

mkdir -p -- "${project_root}/build"
echo "build-workbook: building from $(git -C "${repo}" rev-parse --short HEAD)"
"${repo}/scripts/install.sh" "${project_root}/build" workbook

# The MIT licence travels with the binary: the app redistributes it.
cp -- "${repo}/LICENSE" "${project_root}/build/WORKBOOK-LICENSE"

echo "build-workbook: staged $("${project_root}/build/workbook" version)"
