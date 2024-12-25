import express, { type Express } from "express";
import { createServer } from "http";
import cors from "cors";
import config from "./config";
import { errorHandler } from "./middleware/errorHandler";
import logger from "./middleware/logger";
import prisma from "@cc-amqp-exp/prisma";
import {
  CreateTrackerResponse,
  OrderStatus,
  QueueMessage
} from "@cc-amqp-exp/shared";
import amqp, { Channel, Connection } from "amqplib";
import promClient, { Gauge } from "prom-client";
import os from "os";
// prometheus metrics
const register = new promClient.Registry();

register.setDefaultLabels({
  app: "order-tracking-service"
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

const app: Express = express();
const server = createServer(app);

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
// parse json request body
app.use(express.json());

// parse urlencoded request body
app.use(express.urlencoded({ extended: true }));

app.use(cors({ origin: String(config.cors.origin).split("|") ?? "*" }));

(async () => {
  await connectRabbit();

  //@ts-ignore
  if (!channel) return;

  await channel.consume(
    config.rabbitmq.queues["track-queue"],
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
        // logger.info("Message received: ", parsedMessage);
      } catch (error) {
        logger.error("Failed to parse message");
        return;
      }

      if (!parsedMessage) {
        return;
      }

      if (parsedMessage.message === "order.created") {
        const { orderId } = parsedMessage.data;
        // create tracker
        await prisma.orderTrack.create({
          data: {
            order: {
              connect: {
                id: orderId
              }
            },
            status: "created" as OrderStatus
          }
        });
      } else if (parsedMessage.message === "inventory.checked") {
        const { orderId, isAvailable } = parsedMessage.data;

        if (isAvailable) {
          // we dont need to update the tracker if the inventory is available
          return;
        }

        // update tracker
        await prisma.orderTrack.update({
          where: {
            orderId
          },
          data: {
            status: "canceled" as OrderStatus
          }
        });
      } else if (parsedMessage.message === "payment.processed") {
        const { orderId, status } = parsedMessage.data;

        const newStatus = status === "success" ? "paid" : "canceled";
        // update tracker

        // update tracker
        await prisma.orderTrack.update({
          where: {
            orderId
          },
          data: {
            status: newStatus as OrderStatus
          }
        });
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

app.post("/api/v1/track/create", async (req, res) => {
  res.set("Cache-Control", "no-cache, no-store, must-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  const { orderId } = req.body;

  if (!orderId) {
    res.status(400).json({ error: "orderId is required" });
    return;
  }

  // find order in db
  try {
    const order = await prisma.order.findUnique({
      where: {
        id: orderId
      }
    });

    if (!order) {
      res.status(404).json({ error: `Order ${orderId} not found` });
      return;
    }

    // create tracker
    const tracker = await prisma.orderTrack.create({
      data: {
        orderId: order.id,
        status: "created" as OrderStatus
      }
    });

    res.status(201).json({
      trackerId: tracker.id,
      status: tracker.status
    } as CreateTrackerResponse);
  } catch (error) {
    if (error instanceof Error) {
      logger.error(error.message);
    }
    res.status(500).json({
      error: "Internal Server Error while calling create tracker Endpoint"
    });
    return;
  }
});

app.patch("/api/v1/track/update/:trackerId", async (req, res) => {
  res.set("Cache-Control", "no-cache, no-store, must-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  const { trackerId } = req.params;
  const { newStatus } = req.body;

  if (!trackerId) {
    res.status(400).json({ error: "trackerId is required" });
    return;
  }

  if (!newStatus) {
    res.status(400).json({ error: "newStatus is required" });
    return;
  }

  if (newStatus !== "paid" && newStatus !== "canceled") {
    res
      .status(400)
      .json({ error: "newStatus must be either 'paid' or 'canceled'" });
  }

  try {
    // check if tracker exists
    const tracker = await prisma.orderTrack.findUnique({
      where: {
        id: trackerId
      }
    });

    if (!tracker) {
      res.status(404).json({ error: `Tracker ${trackerId} not found` });
      return;
    }

    // update tracker
    await prisma.orderTrack.update({
      where: {
        id: trackerId
      },
      data: {
        status: newStatus as OrderStatus
      }
    });

    res.status(200).json({ msg: "Tracker updated" });
  } catch (error) {
    if (error instanceof Error) {
      logger.error(error.message);
    }
    res
      .status(500)
      .json({ error: "Internal Server Error while updating tracker" });
    return;
  }
});

app.get("/api/v1/track/:trackerId", async (req, res) => {
  res.set("Cache-Control", "no-cache, no-store, must-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  const { trackerId } = req.params;

  if (!trackerId) {
    res.status(400).json({ error: "trackerId is required" });
    return;
  }

  // find tracker in db
  try {
    const tracker = await prisma.orderTrack.findUnique({
      where: {
        id: trackerId
      }
    });

    if (!tracker) {
      res.status(404).json({ error: `Tracker ${trackerId} not found` });
      return;
    }

    res.status(200).json({
      tracker
    });
  } catch (error) {
    if (error instanceof Error) {
      logger.error(error.message);
    }
    res.status(500).json({
      error: "Internal Server Error while calling get tracker Endpoint"
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
