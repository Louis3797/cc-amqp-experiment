import express, { type Express } from "express";
import { createServer } from "http";
import cors from "cors";
import config from "./config";
import { errorHandler } from "./middleware/errorHandler";
import logger from "./middleware/logger";
import prisma from "@cc-amqp-exp/prisma";
import { PaymentProcessedResponse, QueueMessage } from "@cc-amqp-exp/shared";
import axios from "axios";
import amqplib, { Channel, Connection } from "amqplib";
import promClient, { Gauge } from "prom-client";
import os from "os";

// prometheus metrics
const register = new promClient.Registry();

register.setDefaultLabels({
  app: "payment-service"
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

// Periodically update the Prometheus gauge metric
setInterval((): void => {
  const usage = getCpuUsagePercentage();
  cpuUsageGauge.set(Number(usage));
}, 5000);

axios.defaults.validateStatus = (status) => {
  return status < 500;
};

axios.defaults.headers.common["Cache-Control"] =
  "no-cache, no-store, must-revalidate";
axios.defaults.headers.common["Pragma"] = "no-cache";
axios.defaults.headers.common["Expires"] = "0";

let channel: Channel;

const connectRabbit = async () => {
  logger.info("Trying to connect to RabbitMQ...");

  let conn: Connection;

  try {
    conn = await amqplib.connect(config.rabbitmq.url);
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

const app: Express = express();
const server = createServer(app);

// parse json request body
app.use(express.json());

// parse urlencoded request body
app.use(express.urlencoded({ extended: true }));

app.use(cors({ origin: String(config.cors.origin).split("|") ?? "*" }));

(async () => {
  await connectRabbit();

  // @ts-ignore
  if (!channel || !channel.connection) {
    return;
  }

  await channel.consume(
    config.rabbitmq.queues["payment-queue"],
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

      if (parsedMessage.message === "inventory.checked") {
        const { orderId, isAvailable } = parsedMessage.data;

        if (!isAvailable) {
          // we dont need to process the order if its not available
          // the tracker we be updated by the inventory.checked event

          return;
        }

        try {
          const order = await prisma.order.findUnique({
            where: {
              id: orderId
            },
            include: {
              user: {
                select: {
                  balance: true
                }
              },
              products: {
                select: {
                  price: true
                }
              }
            }
          });

          if (!order) {
            // send payment failed message
            channel.publish(
              config.rabbitmq.exchanges[1],
              "",
              Buffer.from(
                JSON.stringify({
                  message: "payment.processed",
                  data: {
                    orderId,
                    status: "failed"
                  }
                } as QueueMessage)
              )
            );

            return;
          }

          const totalAmount = order.products
            .map((product) => product.price)
            .reduce((acc, price) => acc + price, 0);

          if (order.user.balance < totalAmount) {
            // send payment failed message
            channel.publish(
              config.rabbitmq.exchanges[1],
              "",
              Buffer.from(
                JSON.stringify({
                  message: "payment.processed",
                  data: {
                    orderId,
                    status: "failed"
                  }
                } as QueueMessage)
              )
            );

            return;
          }

          // update user balance
          await prisma.user.update({
            where: {
              id: order.userId
            },
            data: {
              balance: {
                decrement: totalAmount
              }
            }
          });

          // send payment success message

          channel.publish(
            config.rabbitmq.exchanges[1],
            "",
            Buffer.from(
              JSON.stringify({
                message: "payment.processed",
                data: {
                  orderId,
                  status: "success"
                }
              } as QueueMessage)
            )
          );
        } catch (error) {
          if (error instanceof Error) {
            logger.error(error);
          }

          return;
        }
      } else {
        return;
      }
    },
    {
      noAck: true
    }
  );
})();

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

app.get("/", (_req, res) => {
  res.set("Cache-Control", "no-cache, no-store, must-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.status(200).json({ msg: "Up" });
});

app.post("/api/v1/payment", async (req, res) => {
  res.set("Cache-Control", "no-cache, no-store, must-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  const { orderId } = req.body;
  // validate body
  if (!orderId) {
    res.status(400).json({
      orderId: orderId,
      status: "failed"
    } as PaymentProcessedResponse);
    return;
  }
  try {
    // calculate total amount
    const order = await prisma.order.findUnique({
      where: {
        id: orderId
      },
      include: {
        user: {
          select: {
            balance: true
          }
        },
        products: {
          select: {
            price: true
          }
        }
      }
    });

    if (!order) {
      res.status(404).json({
        orderId: orderId,
        status: "failed"
      } as PaymentProcessedResponse);
      return;
    }

    const totalAmount = order.products
      .map((product) => product.price)
      .reduce((acc, price) => acc + price, 0);

    if (order.user.balance < totalAmount) {
      res.status(400).json({
        orderId: orderId,
        status: "failed"
      } as PaymentProcessedResponse);
      return;
    }

    // update stock
    try {
      const inventoryResponse = await axios.patch(
        `${config.services.inventory_service.url}${config.services.inventory_service.endpoint.v1}/update/${orderId}`
      );

      if (inventoryResponse.status !== 200) {
        res.status(400).json({
          orderId: orderId,
          status: "failed"
        } as PaymentProcessedResponse);
        return;
      }
    } catch (error) {
      if (error instanceof Error) {
        logger.error(error.message);
      }
      res.status(500).json({
        error: "Internal Server Error while calling inventory Endpoint"
      });
      return;
    }

    // update user balance
    await prisma.user.update({
      where: {
        id: order.userId
      },
      data: {
        balance: {
          decrement: totalAmount
        }
      }
    });

    // payment processing
    res.status(200).json({
      orderId: order.id,
      status: "success"
    } as PaymentProcessedResponse);
  } catch (error) {
    if (error instanceof Error) {
      logger.error(error.message);
    }
    res.status(500).json({
      error: "Internal Server Error while processing payment"
    });
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
