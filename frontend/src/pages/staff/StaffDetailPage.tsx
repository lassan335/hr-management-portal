import { useParams } from "react-router-dom";
import { StaffDetailView } from "./StaffDetailView";

export function StaffDetailPage() {
  const { id } = useParams<{ id: string }>();
  if (!id) return null;
  return <StaffDetailView targetId={id} />;
}
