import { PaymentStatus } from "./payment";

export type MessageTypes =
  | "order.created"
  | "inventory.checked"
  | "payment.processed";

export type OrderCreatedMessage = {
  orderId: string;
  productIds: string[];
};
export type InventoryCheckedMessage = {
  orderId: string;
  isAvailable: boolean;
};

export type PaymentProcessedMessage = {
  orderId: string;
  status: PaymentStatus;
};

export type QueueMessage =
  | { message: "order.created"; data: OrderCreatedMessage }
  | { message: "inventory.checked"; data: InventoryCheckedMessage }
  | { message: "payment.processed"; data: PaymentProcessedMessage };
