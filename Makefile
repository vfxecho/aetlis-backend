.PHONY: help instant gigasplit ffa crazy selfeed megasplit terasplit build clean all stop restart logs list

help:
	@echo "Commands:"
	@echo ""
	@echo "  make instant"
	@echo "  make gigasplit"
	@echo "  make ffa"
	@echo "  make crazy"
	@echo "  make selfeed"
	@echo "  make megasplit"
	@echo "  make terasplit"
	@echo ""
	@echo "  make all       - start all servers"
	@echo "  make stop      - stop all"
	@echo "  make restart   - restart all"
	@echo "  make logs      - show logs"
	@echo "  make list      - list servers"
	@echo ""
	@echo "  make build     - compile C++"
	@echo "  make clean     - clean build"
	@echo ""

build:
	@npm run build 2>&1 | grep -v "gyp info" || true

clean:
	@npm run clean 2>&1 | grep -v "gyp info" || true

instant: build
	@pm2 delete instant 2>/dev/null || true
	@pm2 start ecosystem.config.js --only instant
	@pm2 logs instant --lines 20

gigasplit: build
	@pm2 delete gigasplit 2>/dev/null || true
	@pm2 start ecosystem.config.js --only gigasplit
	@pm2 logs gigasplit --lines 20

ffa: build
	@pm2 delete ffa 2>/dev/null || true
	@pm2 start ecosystem.config.js --only ffa
	@pm2 logs ffa --lines 20

crazy: build
	@pm2 delete crazy 2>/dev/null || true
	@pm2 start ecosystem.config.js --only crazy
	@pm2 logs crazy --lines 20

selfeed: build
	@pm2 delete selfeed 2>/dev/null || true
	@pm2 start ecosystem.config.js --only selfeed
	@pm2 logs selfeed --lines 20

megasplit: build
	@pm2 delete megasplit 2>/dev/null || true
	@pm2 start ecosystem.config.js --only megasplit
	@pm2 logs megasplit --lines 20

terasplit: build
	@pm2 delete terasplit 2>/dev/null || true
	@pm2 start ecosystem.config.js --only terasplit
	@pm2 logs terasplit --lines 20

all: build
	@pm2 delete all 2>/dev/null || true
	@pm2 start ecosystem.config.js
	@pm2 list

stop:
	@pm2 stop all

restart:
	@pm2 restart all

logs:
	@pm2 logs

list:
	@pm2 list
