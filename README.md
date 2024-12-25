# How to start

> You need to have the latest version of Yarn, Node.js (v22.12.0) and Docker installed.

Add .env files if not defined in each service

```txt
NODE_ENV=development

PORT=4044 # each service needs another port
# (see order-servie/config.ts for which port each service should have)

HOST=0.0.0.0

CORS_ORIGIN=*

# rabbitmq connection string
RABBITMQ_URL=amqp://guest:guest@localhost:5672/
```

my-prisma also needs a .env file with the db connection string

```txt
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/cc-amqp-experiment-db?schema=public"
```

Install first

```bash
yarn install
```

Start Infrastructure

```bash
docker compose -f "docker-compose-infrastructure.yaml" up
```

Create db migration
(should work in root dir if not go in my-prisma directory)

```bash
yarn prisma migrate dev --name init
yarn prisma generate
```

Then run services

```bash
yarn run-all:prod
```

Their will start many services

> For passwords and user see the docker-compose-infrastructure.yaml

- Prometheus: http://localhost:9090 (play around or discover metrics from the services)
- Grafana: http://localhost:3000/ (you can see metrics here)

  - In Grafana you need to import the dashboard copy from grafana-dashboard.json

- Services: http://localhost:{defined Port}/

- RabbitMQ: http://localhost:15672/#/

### Endpoints

order service:

- GET /api/v1/order/:orderId
- POST /api/v1/order/
  - in body
  - `json { "productId": "id" }`
- POST /api/v2/order/ (uses message queue)
  - in body
  - `json { "productId": "id" }`

order tracking service

- GET /api/v1/track/:trackerId
