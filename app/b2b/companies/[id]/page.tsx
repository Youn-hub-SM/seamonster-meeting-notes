import CompanyDetail from "./CompanyDetail";

type PageProps = { params: Promise<{ id: string }> };

export default async function CompanyDetailPage({ params }: PageProps) {
  const { id } = await params;
  return <CompanyDetail companyId={id} />;
}
