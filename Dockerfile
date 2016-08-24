#FROM hive/node-openrc-base:6.3.1
FROM mhart/alpine-node:latest

WORKDIR /code

ADD dist/gateway.js .
ADD node_modules ./node_modules

EXPOSE 8000
CMD [ "node" "/code/gateway.js" ]
