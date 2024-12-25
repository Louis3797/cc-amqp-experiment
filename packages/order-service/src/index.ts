import server from "./app";
import config from "./config";
import logger from "./middleware/logger";

const port: number = Number(config.app.port) || 4041;

server.listen(port, config.app.host, () => {
  logger.log("info", `Server is running on Port: ${port}`);
});

process.on("SIGTERM", () => {
  logger.info("SIGTERM signal received.");
  logger.info("Closing server.");
  server.close((err: unknown) => {
    logger.info("Server closed.");
    // eslint-disable-next-line no-process-exit
    process.exit(err ? 1 : 0);
  });
});
