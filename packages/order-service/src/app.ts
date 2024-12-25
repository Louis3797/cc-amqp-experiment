import express, { type Express } from "express";
import { createServer } from "http";
import cors from "cors";
import config from "./config";
import { errorHandler } from "./middleware/errorHandler";
import logger from "./middleware/logger";
import {
  CheckInventoryResponse,
  CreateTrackerResponse,
  PaymentProcessedResponse,
  QueueMessage
} from "@cc-amqp-exp/shared";
import prisma from "@cc-amqp-exp/prisma";
import axios from "axios";
import { OrderStatus } from "@cc-amqp-exp/shared/src/types/order-tracker";
import amqp, { Channel, Connection } from "amqplib";
import promClient, { Gauge } from "prom-client";
import os from "os";

// prometheus metrics
const register = new promClient.Registry();

register.setDefaultLabels({
  app: "order-service"
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

  console.log(queues);

  for (const queue of queues) {
    const q = await channel.assertQueue(queue);

    await channel.bindQueue(q.queue, config.rabbitmq.exchanges[1], "");
  }
};
(async () => {
  await connectRabbit();
})();
// parse json request body
app.use(express.json());

// parse urlencoded request body
app.use(express.urlencoded({ extended: true }));

app.use(cors({ origin: String(config.cors.origin).split("|") ?? "*" }));

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
  res.status(200).json({ msg: "Up" });
});

app.post("/api/v1/order", async (req, res) => {
  res.set("Cache-Control", "no-cache, no-store, must-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  const { productId } = req.body;

  // validate body
  if (!productId) {
    res.status(400).json({ error: "productId is required" });
    return;
  }

  // if order in stock create order in db
  try {
    const createdOrder = await prisma.order.create({
      data: {
        user: {
          connect: {
            id: "3c3e02d1-af13-412a-b309-5382155a6bd4"
          }
        }
      }
    });

    // send to inventory service
    try {
      const inventoryResponse = await axios.get<CheckInventoryResponse>(
        `${config.services.inventory_service.url}${config.services.inventory_service.endpoint.v1}`,
        {
          data: {
            orderId: createdOrder.id,
            productIds: [productId]
          }
        }
      );

      if (
        inventoryResponse.status !== 200 ||
        !inventoryResponse.data.isAvailable
      ) {
        res.status(400).json({ error: `Product ${productId} not available` });
        return;
      }
    } catch (error) {
      if (error instanceof Error) {
        logger.error(error.message);
        console.log(error);
      }
      res.status(500).json({
        error: "Internal Server Error while calling inventory Endpoint"
      });

      return;
    }

    let trackerId = "";

    // send create request to order tracking service
    try {
      const createTrackerResponse = await axios.post<CreateTrackerResponse>(
        `${config.services.order_tracking_service.url}${config.services.order_tracking_service.endpoint.v1}/create`,
        {
          orderId: createdOrder.id
        },
        {
          headers: {
            "Content-Type": "application/json"
          }
        }
      );

      if (createTrackerResponse.status !== 201) {
        res.status(400).json({
          error: `Failed to create tracker for order ${createdOrder.id}`
        });
        return;
      }

      trackerId = createTrackerResponse.data.trackerId;
    } catch (error) {
      if (error instanceof Error) {
        logger.error(error.message);
      }
      res.status(500).json({
        error: "Internal Server Error while calling create tracker Endpoint"
      });

      return;
    }

    // if in stock send to payment service
    try {
      const paymentResponse = await axios.post<PaymentProcessedResponse>(
        `${config.services.payment_service.url}${config.services.payment_service.endpoint.v1}/`,
        {
          orderId: createdOrder.id
        }
      );

      if (
        paymentResponse.status !== 200 ||
        paymentResponse.data.status !== "success"
      ) {
        // update tracker to status canceled
        await axios.patch(
          `${config.services.order_tracking_service.url}${config.services.order_tracking_service.endpoint.v1}/update/${trackerId}`,
          {
            newStatus: "canceled" as OrderStatus
          },
          {
            headers: {
              "Content-Type": "application/json"
            }
          }
        );

        res.status(400).json({ error: `Product ${productId} couldnt be paid` });
        return;
      }
    } catch (error) {
      if (error instanceof Error) {
        logger.error(error.message);
      }
      res.status(500).json({
        error: "Internal Server Error while calling payment Endpoint"
      });

      return;
    }

    // update tracker to status paid
    await axios.patch(
      `${config.services.order_tracking_service.url}${config.services.order_tracking_service.endpoint.v1}/update/${trackerId}`,
      {
        newStatus: "paid" as OrderStatus
      },
      {
        headers: {
          "Content-Type": "application/json"
        }
      }
    );

    res.status(201).json({
      msg: "Order Created and successfully paid",
      order: createdOrder
    });
  } catch (error) {
    if (error instanceof Error) {
      logger.error(error.message);
    }
    res.status(500).json({
      error: "Internal Server Error while creating order"
    });

    return;
  }
});

app.get("/api/v1/order/:id", async (req, res) => {
  res.set("Cache-Control", "no-cache, no-store, must-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  const { id } = req.params;

  if (!id) {
    res.status(400).json({ error: "id is required" });
    return;
  }
  try {
    const order = await prisma.order.findUnique({
      where: { id },
      include: {
        products: true,
        user: true,
        track: true
      }
    });

    if (!order) {
      res.status(404).json({ error: "Order not found" });
      return;
    }

    res.status(200).json({ order });
  } catch (error) {
    if (error instanceof Error) {
      logger.error(error.message);
    }
    res
      .status(500)
      .json({ error: "Internal Server Error while fetching order" });
  }
});

app.post("/api/v2/order", async (req, res) => {
  res.set("Cache-Control", "no-cache, no-store, must-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  const { productId } = req.body;

  // validate body
  if (!productId) {
    res.status(400).json({ error: "productId is required" });
    return;
  }

  // create order in db
  const createdOrder = await prisma.order.create({
    data: {
      user: {
        connect: {
          id: "3c3e02d1-af13-412a-b309-5382155a6bd4"
        }
      }
    }
  });

  //@ts-ignore
  if (!channel) {
    throw new Error("RabbitMQ channel not available");
  }

  // publish order.created
  const sent = channel.publish(
    config.rabbitmq.exchanges[1],
    "",
    Buffer.from(
      JSON.stringify({
        message: "order.created",
        data: {
          orderId: createdOrder.id,
          productIds: [productId]
        }
      } as QueueMessage)
    )
  );

  if (sent) {
    res.status(201).json({
      msg: "Order Created",
      order: createdOrder
    });
    console.log("Order created and published: order.created");
  } else {
    res.status(500).json({
      error: "Internal Server Error while sending message to order queue"
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
