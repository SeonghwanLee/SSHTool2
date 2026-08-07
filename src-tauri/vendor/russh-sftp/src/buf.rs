use bytes::Buf;

use crate::error::Error;

pub trait TryBuf: Buf {
    fn try_get_bytes(&mut self) -> Result<Vec<u8>, Error>;
    fn try_get_string(&mut self) -> Result<String, Error>;
}

impl<T: Buf> TryBuf for T {
    fn try_get_bytes(&mut self) -> Result<Vec<u8>, Error> {
        let len = self
            .try_get_u32()
            .map_err(|e| Error::UnexpectedBehavior(e.to_string()))? as usize;
        if self.remaining() < len {
            return Err(Error::BadMessage("no remaining for vec".to_owned()));
        }

        Ok(self.copy_to_bytes(len).to_vec())
    }

    fn try_get_string(&mut self) -> Result<String, Error> {
        let bytes = self.try_get_bytes()?;
        // [SSHTool2 패치] 원본은 from_utf8_lossy 라 UTF-8 이 아닌 파일명(EUC-KR 등)이
        // U+FFFD 로 뭉개져 복원이 불가능했다. 바이트 하나를 코드포인트 하나(U+0000~U+00FF)로
        // 옮겨 **무손실**로 전달하고, 문자셋 해석은 호출자(sftp.rs)가 한다.
        // ser.rs 의 serialize_str 이 같은 매핑으로 되돌려 쓴다(쌍을 이룬다).
        Ok(bytes.into_iter().map(|b| b as char).collect())
    }
}
