import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const repoRoot = process.cwd();
const packageJson = await Bun.file(join(repoRoot, "package.json")).json();
const versionArg = process.argv[2]?.trim();
const version = versionArg && versionArg.length > 0 ? versionArg.replace(/^v/, "") : packageJson.version;
const tag = `v${version}`;
const tarballUrl = `https://github.com/ink1ing/anti-api/archive/refs/tags/${tag}.tar.gz`;
const shellNoSelfUpdate = "${ANTI_API_NO_SELF_UPDATE:-0}";
const shellPackageManager = "${ANTI_API_PACKAGE_MANAGER:-}";

const response = await fetch(tarballUrl, {
    headers: {
        "User-Agent": "anti-api-homebrew-formula",
    },
});

if (!response.ok) {
    throw new Error(`Failed to download ${tarballUrl}: ${response.status} ${response.statusText}`);
}

const buffer = Buffer.from(await response.arrayBuffer());
const sha256 = createHash("sha256").update(buffer).digest("hex");

const formula = `class AntiApi < Formula
  desc "Local OpenAI/Anthropic-compatible proxy for Antigravity, Codex, Copilot, and Zed"
  homepage "https://github.com/ink1ing/anti-api"
  url "https://github.com/ink1ing/anti-api/archive/refs/tags/${tag}.tar.gz"
  sha256 "${sha256}"
  license "MIT"
  head "https://github.com/ink1ing/anti-api.git", branch: "main"

  depends_on "oven-sh/bun/bun"
  depends_on "rust" => :build

  def install
    entries = Dir["*"] - %w[anti-api-test-bundle anti-api-v2.6.0 dist]
    libexec.install entries

    cd libexec do
      inreplace "start.command", "do_update() {\\n", <<~SH
        do_update() {
            if [ "${shellNoSelfUpdate}" = "1" ] || [ "${shellPackageManager}" = "homebrew" ]; then
                if [ "${shellPackageManager}" = "homebrew" ]; then
                    echo "This installation is managed by Homebrew. Run: brew upgrade anti-api"
                else
                    echo "Self-update is disabled for this installation."
                fi
                return 0
            fi

      SH
      chmod 0755, "start.command"
      chmod 0755, "a"
      system Formula["bun"].opt_bin/"bun", "install", "--frozen-lockfile"
      system "cargo", "build", "--release", "--manifest-path", "rust-proxy/Cargo.toml"
    end

    (bin/"anti-api").write <<~SH
      #!/bin/bash
      export ANTI_API_PACKAGE_MANAGER=homebrew
      export ANTI_API_NO_SELF_UPDATE=1
      exec "#{libexec}/start.command" "$@"
    SH
    chmod 0755, bin/"anti-api"

    (bin/"a").write <<~SH
      #!/bin/bash
      exec "#{bin}/anti-api" "$@"
    SH
    chmod 0755, bin/"a"
  end

  def caveats
    <<~EOS
      Start Anti-API with:
        anti-api

      This Homebrew package disables in-app self-update.
      Use Homebrew to update this install.
      If you use a private tap or a local formula file, update that formula first,
      then run brew upgrade or brew reinstall.
    EOS
  end

  test do
    output = shell_output("#{bin}/anti-api --update-only 2>&1")
    assert_match "managed by Homebrew", output
  end
end
`;

await mkdir(join(repoRoot, "Formula"), { recursive: true });
await writeFile(join(repoRoot, "Formula", "anti-api.rb"), formula, "utf8");

console.log(`Updated Formula/anti-api.rb for ${tag}`);
console.log(`sha256: ${sha256}`);
