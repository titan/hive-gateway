DISTDIR=./dist
SRCDIR=./src
SERVER=$(DISTDIR)/gateway.js
NPM=npm

NS = hive
VERSION ?= 1.0.0

REPO = gateway

all: $(SERVER)

$(SERVER): $(SRCDIR)/gateway.ts
	tsc || rm $(SERVER)
	
$(SRCDIR)/gateway.ts: node_modules typings

node_modules:
	$(NPM) install

typings:
	typings install

build: all
	docker build -t $(NS)/$(REPO):$(VERSION) .

rmi:
	docker rmi $(NS)/$(REPO):$(VERSION)

clean:
	rm -rf $(DISTDIR)

.PHONY: all build rmi clean
