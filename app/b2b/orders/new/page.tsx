import OrderForm from "../OrderForm";

type PageProps = {
  searchParams: Promise<{ from?: string }>;
};

export default async function NewOrderPage({ searchParams }: PageProps) {
  const { from } = await searchParams;
  return <OrderForm mode="create" cloneFromId={from} />;
}
