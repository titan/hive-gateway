DISTDIR=./dist
SRCDIR=./src
SERVER=$(DISTDIR)/gateway.js
NPM=npm

all: $(SERVER)

$(SERVER): $(SRCDIR)/gateway.ts
	tsc || rm $(SERVER)

$(SRCDIR)/gateway.ts: node_modules typings

node_modules:
	$(NPM) install

typings:
	typings install

clean:
	rm -rf $(DISTDIR)

.PHONY: all clean
