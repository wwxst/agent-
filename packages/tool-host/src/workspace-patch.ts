import {createHash} from 'node:crypto';
import {KernelError} from '../../contracts/src/index.js';

/**
 * Pure patch-planning primitive. It NEVER accesses the filesystem.
 * A trusted Workspace controller must separately bind paths to a staged
 * workspace, check every filesystem object, authorize the change, and
 * perform crash-safe commit. Do not register this as a model tool directly.
 */
export interface WorkspacePatchInput {
  readonly path: string;
  readonly expectedSha256: string;
  readonly oldText: string;
  readonly newText: string;
}
export interface WorkspacePatchPreview {
  readonly path: string;
  readonly baseSha256: string;
  readonly candidateSha256: string;
  readonly candidate: string;
}
const MAX_SOURCE_BYTES=256*1024;
const MAX_PATCH_FIELD_BYTES=64*1024;
const sha256=(text:string):string=>createHash('sha256').update(text,'utf8').digest('hex');
function reject(code:string,message:string):never{
  throw new KernelError(code,message);
}
export function validateWorkspacePatch(input:unknown):WorkspacePatchInput{
  if(!input||typeof input!=='object'||Array.isArray(input))
    reject('WORKSPACE_PATCH_INVALID','Patch request must be an object');
  const v=input as Record<string,unknown>;
  if(Object.keys(v).length!==4 || !['path','expectedSha256','oldText','newText']
    .every(key=>Object.hasOwn(v,key)))
    reject('WORKSPACE_PATCH_INVALID','Unexpected or missing patch fields');
  if(typeof v.path!=='string'||typeof v.expectedSha256!=='string'
    ||typeof v.oldText!=='string'||typeof v.newText!=='string')
    reject('WORKSPACE_PATCH_INVALID','Patch fields must be strings');
  const path=v.path as string, expectedSha256=v.expectedSha256 as string;
  const oldText=v.oldText as string, newText=v.newText as string;
  const parts=path.split('/');
  if(path.length===0||path.length>240||path.startsWith('/')
    ||parts.some(part=>!part||part==='.'||part==='..'||part==='.git'
      ||!/^[a-zA-Z0-9._-]+$/.test(part)))
    reject('WORKSPACE_PATCH_PATH_DENIED','Only canonical relative paths are accepted');
  if(!/^[0-9a-f]{64}$/.test(expectedSha256))
    reject('WORKSPACE_PATCH_INVALID','Expected SHA-256 must be lowercase hex');
  if(!oldText||oldText===newText
    ||Buffer.byteLength(oldText,'utf8')>MAX_PATCH_FIELD_BYTES
    ||Buffer.byteLength(newText,'utf8')>MAX_PATCH_FIELD_BYTES)
    reject('WORKSPACE_PATCH_INVALID','Patch must be bounded, nonempty and changing');
  return {path,expectedSha256,oldText,newText};
}
export function previewWorkspacePatch(content:string,input:WorkspacePatchInput):WorkspacePatchPreview{
  const patch=validateWorkspacePatch(input);
  if(typeof content!=='string'||Buffer.byteLength(content,'utf8')>MAX_SOURCE_BYTES)
    reject('WORKSPACE_PATCH_TOO_LARGE','Source is not a bounded UTF-8 text');
  const baseSha256=sha256(content);
  if(baseSha256!==patch.expectedSha256)
    reject('WORKSPACE_PATCH_STALE_BASE','Source changed after review');
  const start=content.indexOf(patch.oldText);
  if(start<0)reject('WORKSPACE_PATCH_NO_MATCH','Expected snippet not found');
  if(content.indexOf(patch.oldText,start+1)>=0)
    reject('WORKSPACE_PATCH_AMBIGUOUS','Expected snippet occurs more than once');
  const candidate=content.slice(0,start)+patch.newText+content.slice(start+patch.oldText.length);
  if(Buffer.byteLength(candidate,'utf8')>MAX_SOURCE_BYTES)
    reject('WORKSPACE_PATCH_TOO_LARGE','Candidate exceeds maximum size');
  return {path:patch.path,baseSha256,candidateSha256:sha256(candidate),candidate};
}
