#!/usr/bin/env python3
"""Build agent-bridge-<version>.vsix without vsce: the extension plus a bundled copy of the runtime (bridge-js/ and web/).

  python3 scripts/build_vsix.py [--relay https://HOST[:PORT]|HOST:PORT] [--source ..] [--out dist]

--source is the repository root (bridge-js/, web/); the files are
bundled under extension/runtime/ with the same layout.

--relay sets the default value of the agentBridge.relayAddress setting, so users need not type it.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

ROOT = Path(__file__).resolve().parent.parent
EXTENSION_FILES = ["extension.js", "README.md", "lib/supervisor.js", "lib/pairing-html.js", "lib/updater.js", "lib/naming.js", "lib/claude-locate.js", "uninstall.js"]
CONTENT_TYPES = {
    ".json": "application/json", ".js": "application/javascript", ".md": "text/markdown",
    ".py": "text/x-python", ".cs": "text/plain", ".html": "text/html", ".css": "text/css", ".vsixmanifest": "text/xml",
}
FIXED_TIME = (2020, 1, 1, 0, 0, 0)


RUNTIME_ENTRIES = []
RUNTIME_DIRS = {"bridge-js": ("*.js",), "bridge-js/lib": ("*.js", "*.cs"), "web": ("*",)}


def runtime_files(source: Path) -> list[tuple[str, Path]]:
    files = [(f"runtime/{name}", source / name) for name in RUNTIME_ENTRIES]
    for folder, patterns in RUNTIME_DIRS.items():
        for pattern in patterns:
            files += [(f"runtime/{folder}/{p.name}", p) for p in sorted((source / folder).glob(pattern)) if p.is_file()]
    missing = [name for name, path in files if not path.is_file()]
    for required in ("runtime/bridge-js/server.js", "runtime/bridge-js/relay-client.js"):
        if not any(name == required for name, _ in files):
            missing.append(required)
    if missing:
        raise SystemExit(f"{source} does not look like the repository root (missing: {', '.join(missing)})")
    return files


def manifest_xml(pkg: dict, changelog: bool = False) -> str:
    changelog_asset = '    <Asset Type="Microsoft.VisualStudio.Services.Content.Changelog" Path="extension/CHANGELOG.md" Addressable="true" />\n' if changelog else ""
    return f"""<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="{escape(pkg['name'])}" Version="{escape(pkg['version'])}" Publisher="{escape(pkg['publisher'])}" />
    <DisplayName>{escape(pkg['displayName'])}</DisplayName>
    <Description xml:space="preserve">{escape(pkg['description'])}</Description>
    <Tags></Tags>
    <Categories>{escape(','.join(pkg['categories']))}</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="{escape(pkg['engines']['vscode'])}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="{escape(','.join(pkg['extensionKind']))}" />
      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
{changelog_asset}  </Assets>
</PackageManifest>
"""


def content_types_xml(names: list[str]) -> str:
    extensions = {Path(n).suffix for n in names} | {".json", ".vsixmanifest"}
    defaults = "".join(
        f'<Default Extension="{ext}" ContentType="{CONTENT_TYPES.get(ext, "application/octet-stream")}"/>'
        for ext in sorted(extensions) if ext)
    return f'<?xml version="1.0" encoding="utf-8"?>\n<Types>{defaults}</Types>\n'


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--relay", default="", help="default relay address: https://HOST[:PORT] (encrypted) or HOST:PORT")
    parser.add_argument("--source", default=str(ROOT.parent), help="repository root")
    parser.add_argument("--out", default=str(ROOT / "dist"))
    args = parser.parse_args()
    if args.relay and not re.fullmatch(r"https://[A-Za-z0-9.-]+(:\d{1,5})?/?|[^\s:/]+:\d{1,5}", args.relay):
        raise SystemExit("--relay must look like https://HOST[:PORT] or HOST:PORT")

    pkg = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    if args.relay:
        pkg["contributes"]["configuration"]["properties"]["agentBridge.relayAddress"]["default"] = args.relay

    entries: list[tuple[str, bytes]] = [("extension/package.json", (json.dumps(pkg, ensure_ascii=False, indent=2) + "\n").encode())]
    entries += [(f"extension/{name}", (ROOT / name).read_bytes()) for name in EXTENSION_FILES]
    # Optional: without it the package is built with self-update disabled (make release-key creates it).
    if (ROOT / "update-public-key.pem").is_file():
        entries.append(("extension/update-public-key.pem", (ROOT / "update-public-key.pem").read_bytes()))
    entries += [(f"extension/{name}", path.read_bytes()) for name, path in runtime_files(Path(args.source).resolve())]
    # the "变更日志" tab of the extension page
    changelog = Path(args.source).resolve() / "CHANGELOG.md"
    if changelog.is_file():
        entries.append(("extension/CHANGELOG.md", changelog.read_bytes()))
    names = [name for name, _ in entries]
    entries.append(("extension.vsixmanifest", manifest_xml(pkg, changelog.is_file()).encode()))
    entries.append(("[Content_Types].xml", content_types_xml(names).encode()))

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    target = out_dir / f"{pkg['name']}-{pkg['version']}.vsix"
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in entries:
            info = zipfile.ZipInfo(name, FIXED_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, data)
    print(f"{target}  ({len(entries)} files, {target.stat().st_size // 1024} KiB)")


if __name__ == "__main__":
    sys.exit(main())
