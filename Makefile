.PHONY: wasm install dev

wasm:
	./wasm/build.sh

install:
	cd relay && npm install
	cd web && npm install

dev:
	@echo "Run in two terminals:"
	@echo "  cd relay && npm run dev"
	@echo "  cd web && npm run dev -- --host 0.0.0.0"
