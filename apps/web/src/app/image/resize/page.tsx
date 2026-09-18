import { type AvailableToolId, getAvailableToolById } from "@hereisit/tool-registry/catalog";
import { ImageWorkbench } from "../../../components/image-workbench";
import { ToolDetailPage } from "../../../components/tool-detail-page";
import { createToolMetadata } from "../../../lib/metadata";
import { getToolImplementation } from "../../../lib/tool-implementations";

const toolId = "image.resize" satisfies AvailableToolId;
const implementation = getToolImplementation(toolId);

export const metadata = createToolMetadata(getAvailableToolById(toolId));

export default function ResizeImagePage() {
  return (
    <ToolDetailPage
      toolId={toolId}
      workbench={<ImageWorkbench intent={implementation.intent} toolId={toolId} />}
      guide={
        <>
          <h2>이미지 크기와 비율 조절 안내</h2>
          <p>
            이미지 크기는 가로와 세로의 픽셀 수를 뜻합니다. 기본 설정은 비율을 유지하며 긴 변을 최대
            1920px로 줄이고 WebP로 저장합니다. 제출처가 JPG나 PNG를 요구한다면 실행 전에 출력 형식도
            바꿔 주세요. 파일은 이 기기에서 처리됩니다.
          </p>
          <h3>최대 크기와 백분율은 어떻게 다른가요?</h3>
          <p>
            ‘최대 크기’는 긴 변의 상한을 지정할 때 사용합니다. 예를 들어 4000×3000 이미지를 긴 변
            최대 2000px로 줄이면 2000×1500이 됩니다. ‘백분율’에서 50%를 선택해도 가로와 세로가 각각
            절반이 됩니다. 픽셀 수는 원본의 4분의 1이지만 파일 용량까지 정확히 4분의 1이 되는 것은
            아닙니다.
          </p>
          <h3>정사각형이 필요하면 어떻게 하나요?</h3>
          <p>
            ‘정사각 자르기’는 사진 전체를 찌그러뜨리는 대신 일부 영역을 잘라 정사각형으로 만듭니다.
            인물이나 글자가 가장자리에 있다면 결과에서 잘리지 않았는지 확인하세요. 남길 영역을 직접
            정하려면 이미지 자르기 도구를 이용하세요.
          </p>
          <h3>작은 이미지를 확대하면 선명해지나요?</h3>
          <p>
            확대는 픽셀 수를 늘리지만 원본에 없는 세부 정보를 복원하지는 않습니다. 작은 이미지는
            기본적으로 확대하지 않으며, 필요할 때 ‘작은 이미지는 확대하기’를 선택할 수 있습니다.
            다운로드한 결과의 실제 크기와 선명도를 함께 확인하세요.
          </p>
        </>
      }
    />
  );
}
