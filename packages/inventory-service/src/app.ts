import express, { type Express } from "express";
import { createServer } from "http";
import cors from "cors";
import config from "./config";
import { errorHandler } from "./middleware/errorHandler";
import prisma from "@cc-amqp-exp/prisma";
import logger from "./middleware/logger";
import { CheckInventoryResponse, QueueMessage } from "@cc-amqp-exp/shared";
import amqp, { Channel, Connection } from "amqplib";
import promClient, { Gauge } from "prom-client";
import os from "os";

// prometheus metrics
const register = new promClient.Registry();

register.setDefaultLabels({
  app: "inventory-service"
});

// Create a histogram metric
const httpRequestDurationMs = new promClient.Histogram({
  name: "http_request_duration_ms",
  help: "Duration of HTTP requests in milliseconds",
  labelNames: ["method", "route", "status_code"],
  buckets: [50, 100, 300, 500, 1000, 1500, 2000, 5000] // Define latency buckets in milliseconds
});
register.registerMetric(httpRequestDurationMs);

const httpRequestsTotal = new promClient.Counter({
  name: "http_requests_total",
  help: "Total number of HTTP requests",
  labelNames: ["method", "route", "status_code"]
});
register.registerMetric(httpRequestsTotal);

const activeConnections = new promClient.Gauge({
  name: "active_connections",
  help: "Number of active connections to the server"
});
register.registerMetric(activeConnections);

// Define the Prometheus gauge metric
const cpuUsageGauge = new Gauge({
  name: "node_cpu_usage_percentage",
  help: "CPU usage as a percentage"
});
register.registerMetric(cpuUsageGauge);

promClient.collectDefaultMetrics({ register });

// ====================

// Variables to track previous CPU times
let previousIdle: number = 0;
let previousTotal: number = 0;

// Function to calculate CPU usage percentage over an interval
function getCpuUsagePercentage(): string {
  const cpus = os.cpus();
  let totalIdle = 0;
  let totalTick = 0;

  cpus.forEach((core) => {
    for (const type in core.times) {
      totalTick += core.times[type as keyof typeof core.times];
    }
    totalIdle += core.times.idle;
  });

  // Calculate deltas
  const idleDelta = totalIdle - previousIdle;
  const totalDelta = totalTick - previousTotal;

  // Update previous values
  previousIdle = totalIdle;
  previousTotal = totalTick;

  // Avoid division by zero
  if (totalDelta === 0) {
    return "0.00";
  }

  const usagePercentage = ((totalDelta - idleDelta) / totalDelta) * 100;
  return usagePercentage.toFixed(2);
}

const app: Express = express();
const server = createServer(app);

// Periodically update the Prometheus gauge metric
setInterval((): void => {
  const usage = getCpuUsagePercentage();
  cpuUsageGauge.set(Number(usage));
}, 5000);

let channel: Channel;

const connectRabbit = async () => {
  logger.info("Trying to connect to RabbitMQ...");

  let conn: Connection;

  try {
    conn = await amqp.connect(config.rabbitmq.url);
  } catch (err) {
    logger.error("Unable to connect to RabbitMQ: ", err);
    setTimeout(
      async () => await connectRabbit(),
      config.rabbitmq.retryInterval
    );
    return;
  }

  logger.info("Successfully connected to RabbitMQ");

  conn.on("close", async function (err: Error) {
    console.error("Rabbit connection closed with error: ", err);
    setTimeout(
      async () => await connectRabbit(),
      config.rabbitmq.retryInterval
    );
  });

  channel = await conn.createChannel();

  await channel.assertExchange(config.rabbitmq.exchanges[1], "fanout", {
    durable: false
  });

  const queues = Object.values(config.rabbitmq.queues);

  for (const queue of queues) {
    const q = await channel.assertQueue(queue);

    await channel.bindQueue(q.queue, config.rabbitmq.exchanges[1], "");
  }
};

app.use((req, res, next) => {
  activeConnections.inc(); // Increment on new connection
  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start; // Calculate duration in milliseconds

    httpRequestDurationMs.observe(
      {
        method: req.method,
        route: req.route?.path || req.url,
        status_code: res.statusCode
      },
      duration
    );

    // Track total requests
    httpRequestsTotal.inc({
      method: req.method,
      route: req.route?.path || req.url,
      status_code: res.statusCode
    });

    activeConnections.dec(); // Decrement when response finishes
  });
  next();
});

app.get("/metrics", async (_req, res) => {
  res.setHeader("Content-Type", register.contentType);
  res.send(await register.metrics());
});

// parse json request body
app.use(express.json());

// parse urlencoded request body
app.use(express.urlencoded({ extended: true }));

app.use(cors({ origin: String(config.cors.origin).split("|") ?? "*" }));

(async () => {
  await connectRabbit();

  //@ts-ignore
  if (!channel) {
    return;
  }
  await channel.consume(
    config.rabbitmq.queues["iventory-queue"],
    async (msg) => {
      if (!msg) {
        return;
      }
      const m = msg.content.toString();

      if (!m) {
        return;
      }

      let parsedMessage: QueueMessage;
      try {
        parsedMessage = JSON.parse(msg.content.toString()) as QueueMessage;
      } catch (error) {
        logger.error("Failed to parse message");
        return;
      }

      if (!parsedMessage) {
        return;
      }

      // ========================================
      // order.created
      // ========================================
      if (parsedMessage.message === "order.created") {
        const { orderId, productIds } = parsedMessage.data;

        try {
          const products = await prisma.products.findMany({
            where: {
              id: {
                in: productIds
              }
            }
          });

          if (products.length === 0) {
            logger.error("Products not found");

            return;
          }

          const groupedProducts = productIds.reduce(
            (acc, id) => {
              acc[id] = acc[id] === undefined ? 1 : acc[id]! + 1;
              return acc;
            },
            {} as Record<string, number>
          );

          const isAvailable = products.every(
            (product) =>
              groupedProducts[product.id] &&
              groupedProducts[product.id]! <= product.stockAmount
          );

          // if available, update order and add products
          if (isAvailable) {
            await prisma.order.update({
              where: {
                id: orderId
              },
              data: {
                products: {
                  connect: products.map((product) => ({ id: product.id }))
                }
              }
            });
          }

          // send to inventory.checked
          channel.publish(
            config.rabbitmq.exchanges[1],
            "",
            Buffer.from(
              JSON.stringify({
                message: "inventory.checked",
                data: {
                  orderId,
                  isAvailable
                }
              } as QueueMessage)
            )
          );
        } catch (error) {
          if (error instanceof Error) {
            logger.error(error.message);
          }

          return;
        }
      } else if (parsedMessage.message === "payment.processed") {
        // ========================================
        // payment.processed
        // ========================================

        // decrease stock

        const { orderId, status } = parsedMessage.data;

        if (status === "failed") {
          return;
        }

        try {
          const order = await prisma.order.findUnique({
            where: {
              id: orderId
            },
            include: {
              products: {
                select: {
                  id: true
                }
              }
            }
          });

          if (!order) {
            logger.error(`Order ${orderId} not found`);
            return;
          }

          // update inventory
          await prisma.products.updateMany({
            where: {
              id: {
                in: order.products.map((product) => product.id)
              }
            },
            data: {
              stockAmount: {
                decrement: 1
              }
            }
          });
        } catch (error) {
          if (error instanceof Error) {
            logger.error(error.message);
          }

          return;
        }
      } else {
        // ========================================
        // inventory.checked
        // ========================================

        return;
      }
    },
    {
      noAck: true
    }
  );
})();

app.get("/", (_req, res) => {
  res.status(200).json({ msg: "Up" });
});

app.get("/api/v1/inventory", async (req, res) => {
  res.set("Cache-Control", "no-cache, no-store, must-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");

  const { orderId, productIds } = req.body as {
    orderId: string;
    productIds: string[];
  };

  if (!orderId || !productIds || productIds.length === 0) {
    res.status(400).json({ error: "orderId and productIds are required" });
    return;
  }

  try {
    const products = await prisma.products.findMany({
      where: {
        id: {
          in: productIds
        }
      }
    });

    if (products.length === 0) {
      res.status(404).json({ error: `Products not found` });
      return;
    }

    const groupedProducts = productIds.reduce(
      (acc, id) => {
        acc[id] = acc[id] === undefined ? 1 : acc[id]! + 1;
        return acc;
      },
      {} as Record<string, number>
    );

    const isAvailable = products.every(
      (product) =>
        groupedProducts[product.id] &&
        groupedProducts[product.id]! <= product.stockAmount
    );

    // if available, update order and add products
    if (isAvailable) {
      await prisma.order.update({
        where: {
          id: orderId
        },
        data: {
          products: {
            connect: products.map((product) => ({ id: product.id }))
          }
        }
      });
    }

    res.status(200).json({
      orderId: orderId,
      isAvailable
    } as CheckInventoryResponse);
  } catch (error) {
    if (error instanceof Error) {
      logger.error(error.message);
    }
    res.status(500).json({
      error: "Internal Server Error while calling inventory Endpoint"
    });
    return;
  }
});

app.patch("/api/v1/inventory/update/:orderId", async (req, res) => {
  const { orderId } = req.params;

  res.set("Cache-Control", "no-cache, no-store, must-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");

  if (!orderId) {
    res.status(400).json({ error: "orderId is required" });
    return;
  }

  try {
    const order = await prisma.order.findUnique({
      where: {
        id: orderId
      },
      include: {
        products: {
          select: {
            id: true
          }
        }
      }
    });

    if (!order) {
      res.status(404).json({ error: `Order ${orderId} not found` });
      return;
    }

    // update inventory
    await prisma.products.updateMany({
      where: {
        id: {
          in: order.products.map((product) => product.id)
        }
      },
      data: {
        stockAmount: {
          decrement: 1
        }
      }
    });

    res.status(200).json({ msg: "Inventory updated successfully" });
  } catch (error) {
    if (error instanceof Error) {
      logger.error(error.message);
    }
    res.status(500).json({
      error: "Internal Server Error while calling update inventory Endpoint"
    });
    return;
  }
});

app.all("*", (_req, res) => {
  res.set("Cache-Control", "no-cache, no-store, must-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.status(404).json({ error: "404 Not Found" });
});

app.use(errorHandler);

export default server;
