import { OrderStatus } from "./order-tracker";
import { PaymentStatus } from "./payment";

export type CheckInventoryResponse = {
  orderId: string;
  isAvailable: boolean;
};

export type CreateTrackerResponse = {
  trackerId: string;
  status: OrderStatus;
};

export type PaymentProcessedResponse = {
  orderId: string;
  status: PaymentStatus;
};
