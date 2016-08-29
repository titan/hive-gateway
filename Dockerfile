FROM mhart/alpine-node:latest

WORKDIR /code

ADD dist/gateway.js .
ADD node_modules ./node_modules

EXPOSE 8000
CMD [ "forever", "-c", "node", "/code/gateway.js" ]
