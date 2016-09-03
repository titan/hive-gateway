FROM hive/node-base:6.3.1

WORKDIR /code

ADD dist/gateway.js .
ADD node_modules ./node_modules

EXPOSE 8000
CMD [ "forever", "-c", "node", "/code/gateway.js" ]
