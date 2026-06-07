import OrderForm from "../OrderForm";

type PageProps = {
  params: Promise<{ id: string }>;
};

export default async function EditOrderPage({ params }: PageProps) {
  const { id } = await params;
  return <OrderForm mode="edit" orderId={id} />;
}
