import { type AvailableToolId, getAvailableToolById } from "@hereisit/tool-registry/catalog";
import { ImageCompressWorkbench } from "../../../components/image-compress-workbench";
import { ToolDetailPage } from "../../../components/tool-detail-page";
import { createToolMetadata } from "../../../lib/metadata";

const toolId = "image.compress" satisfies AvailableToolId;

export const metadata = createToolMetadata(getAvailableToolById(toolId));

export default function CompressImagePage() {
  return (
    <ToolDetailPage
      toolId={toolId}
      workbench={<ImageCompressWorkbench toolId={toolId} />}
      guide={
        <>
          <h2>이미지 용량을 줄일 때 확인할 점</h2>
          <p>
            사진을 메일에 첨부하거나 게시판에 올리려면 파일 용량과 가로·세로 크기를 구분해 보세요.
            압축은 저장에 필요한 바이트를 줄이는 작업이고, 크기 조절은 이미지의 픽셀 수를 바꾸는
            작업입니다. 제출 조건이 KB·MB인지, 가로·세로 px인지 먼저 확인하면 도구를 고르기
            쉽습니다.
          </p>
          <h3>어떤 압축 옵션을 선택해야 하나요?</h3>
          <p>
            처음에는 ‘추천’으로 처리하고 결과를 확인하세요. 용량을 더 줄이는 옵션은 작은 글씨나
            사진의 미세한 질감에 영향을 줄 수 있습니다. ‘무손실’은 픽셀을 바꾸지 않는 방식이므로
            이미 최적화된 파일에서는 줄어드는 양이 작을 수 있습니다.
          </p>
          <h3>압축했는데 왜 원본이 유지되나요?</h3>
          <p>
            이미 압축된 사진이나 단순한 그림은 다시 처리해도 더 작아지지 않을 수 있습니다.
            HereIsIt은 압축 결과가 더 작지 않으면 원본을 유지합니다. 모든 파일에서 같은 감소율을
            보장하지 않으며, 더 작은 해상도가 괜찮다면 이미지 크기 조절 도구도 활용할 수 있습니다.
          </p>
          <h3>파일은 어디에서 처리하나요?</h3>
          <p>
            기본 고성능 서버 압축은 선택한 파일을 서버로 전송합니다. 파일을 전송하고 싶지 않다면
            실행 전에 ‘내 기기에서 처리’를 선택하세요. 서버를 이용할 수 없을 때는 기기 내 처리로
            전환될 수 있으며, 처리 방식에 따라 지원 범위와 압축 결과가 달라질 수 있습니다.
          </p>
          <h3>결과는 어떻게 확인하나요?</h3>
          <p>
            원본과 결과의 용량을 비교한 뒤 다운로드하세요. 중요한 사진이나 글자가 있는 이미지는
            저장한 결과를 확대해 확인하고 원본도 보관하는 것이 좋습니다. 용량 감소율은 화질 점수가
            아니므로, 숫자만으로 결과의 품질을 판단하지 마세요.
          </p>
        </>
      }
    />
  );
}
