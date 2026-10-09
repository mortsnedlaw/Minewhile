.PHONY: yespower wasm install test build dev production

yespower:
	./scripts/ensure-yespower.sh

wasm: yespower
	./wasm/build.sh

install: yespower
	cd relay && npm ci
	cd web && npm ci

test:
	cd relay && npm test

build: yespower
	cd relay && npm run build
	cd web && npm run build

dev:
	@echo "Run in two terminals:"
	@echo "  cd relay && npm run dev"
	@echo "  cd web && npm run dev -- --host 0.0.0.0"

production:
	@echo "Example:"
	@echo "  sudo MINEWHILE_DOMAIN=mine.example.com DEV_WALLET=... ./scripts/install-production.sh"
