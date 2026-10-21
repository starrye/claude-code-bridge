PYTHON ?= python3
RELAY ?=

.PHONY: test test-bridge test-extension test-web relay-package vsix release release-key clean

test: test-bridge test-extension

# 中继、二维码，对 bridge-js/server.js 的集成测试（用 tests/bridge/fake_claude.py 代替真实的 claude），以及 bridge-js 的 Node 单元测试
test-bridge:
	$(PYTHON) -m unittest discover -s tests -t . -p "test_*.py"
	for f in tests/parity/*_parity.py; do $(PYTHON) $$f || exit 1; done
	node --test tests/bridge-js/

test-extension:
	cd vscode-extension && node --test test/

# 手机端页面测试，需要先 npm install jsdom
test-web:
	node --test tests/web/

# 中继部署包：relay.py + relay_lib/ + web/
relay-package:
	mkdir -p dist
	tar czf dist/agent-bridge-relay.tgz relay.py relay_lib/*.py web/index.html web/app.js web/markdown.js web/style.css
	@(sha256sum dist/agent-bridge-relay.tgz 2>/dev/null || shasum -a 256 dist/agent-bridge-relay.tgz)

# VS Code 插件，可用 RELAY=host:port 写入默认中继地址
vsix:
	cd vscode-extension && $(PYTHON) scripts/build_vsix.py $(if $(RELAY),--relay $(RELAY),)

# 发布插件更新：打包、算校验值、用私钥签名，产出 updates/{agent-bridge-X.Y.Z.vsix,latest.json}，随仓库提交
# 先把版本号升在 vscode-extension/package.json 里；首次使用先 make release-key
release:
	cd vscode-extension && node scripts/release.js $(if $(RELAY),--relay $(RELAY),)

release-key:
	cd vscode-extension && node scripts/release.js --init-key

clean:
	rm -rf dist vscode-extension/dist
	find . -name __pycache__ -type d -not -path './.git/*' -prune -exec rm -rf {} +
