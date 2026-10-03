/** Privileged transactional content publisher. Never imported by the HTTP runtime. */
import { readFile } from 'node:fs/promises';
import { validatePackage, packageHash, canonicalJson, objectiveItems, validatePlayback } from '../package-contract.mjs';
import { readMediaBytes } from '../media-contract.mjs';
import { BODY_LIMIT_BYTES } from '../owned-api.mjs';

const fail=message=>{const e=new Error(message);e.code='package_conflict';throw e;};
export async function importPackage(pool,input,{dryRun=false,publisher='content-cli',mediaRoot}={}) {
  const p=validatePackage(input);
  if(typeof publisher!=='string'||!publisher.trim()||publisher.length>200) throw new Error('publisher required');
  // Never open a publishing transaction until every authored byte stream is verified.
  for(const media of p.media||[]) await readMediaBytes(media,{mediaRoot});
  const client=await pool.connect();
  const changes=[];
  const commands=[];
  let begun=false;
  const plan=(description,sql,params)=>{changes.push(description);commands.push([sql,params]);};
  try {
    const role=(await client.query(`SELECT current_user=(SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname=current_schema()) AS publisher`)).rows[0];
    if(!role.publisher) throw new Error('content publishing requires the schema-owner migration role');
    // Reference-only releases also verify their immutable source bytes before BEGIN. Mutable
    // publication/rights decisions are read again inside the publisher transaction below.
    const verifiedMedia=new Set((p.media||[]).map(m=>m.mediaId+'@'+m.version));
    for(const form of p.forms) for(const member of form.members.filter(m=>m.interaction==='fixed_audio')) {
      const authored=p.sets.find(s=>s.setId===member.setId&&s.version===member.version);
      const set=authored?{exam_id:authored.examId,payload:authored.payload}:(await client.query('SELECT exam_id,payload FROM objective_set WHERE set_id=$1 AND version=$2',[member.setId,member.version])).rows[0];
      if(!set||set.exam_id!==p.exam.id) fail('missing or incompatible exact set: '+member.setId);
      objectiveItems(set.payload,'fixed_audio');
      for(const recording of set.payload.recordings) {
        const identity=recording.mediaId+'@'+recording.mediaVersion;
        if(verifiedMedia.has(identity)) continue;
        const asset=(await client.query('SELECT * FROM exam_media WHERE media_id=$1 AND version=$2',[recording.mediaId,recording.mediaVersion])).rows[0];
        if(!asset||asset.exam_id!==p.exam.id) fail('missing or incompatible exact media: '+identity);
        await readMediaBytes(asset,{mediaRoot});verifiedMedia.add(identity);
      }
    }
    await client.query('BEGIN');begun=true;
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,7351))",[p.exam.id]);
    const exam=(await client.query('SELECT * FROM exam_package WHERE exam_id=$1',[p.exam.id])).rows[0];
    if(exam && exam.exam_language!==p.exam.language) fail('exam language is immutable');
    if(!exam) plan('add exam '+p.exam.id,'INSERT INTO exam_package(exam_id,exam,level,exam_language,blueprint_version) VALUES($1,$2,$3,$4,$5)',
      [p.exam.id,p.exam.title,p.exam.levelModel.levels?.join('–')||p.exam.levelModel.type,p.exam.language,p.blueprint.version]);
    const blueprintHash=packageHash({exam:p.exam,blueprint:p.blueprint});
    const blueprint=(await client.query('SELECT sha256 FROM exam_blueprint WHERE exam_id=$1 AND version=$2',[p.exam.id,p.blueprint.version])).rows[0];
    if(blueprint && blueprint.sha256!==blueprintHash) fail('changed blueprint under existing version');
    if(!blueprint) plan('add blueprint '+p.blueprint.version,'INSERT INTO exam_blueprint(exam_id,version,payload,sha256) VALUES($1,$2,$3::jsonb,$4)',[p.exam.id,p.blueprint.version,canonicalJson({exam:p.exam,...p.blueprint}),blueprintHash]);
    const media=new Map();
    for(const m of p.media||[]) {
      const digest=packageHash(m),cv=m.mediaId+'@'+m.version;
      const old=(await client.query(`SELECT m.*,c.content_sha256,c.review_status,COALESCE(cr.basis,c.rights_status) AS rights_status
        FROM exam_media m JOIN content_version c USING(content_version_id) LEFT JOIN content_rights cr USING(content_version_id)
        WHERE media_id=$1 AND version=$2`,[m.mediaId,m.version])).rows[0];
      if(old&&(old.content_sha256!==digest||old.exam_id!==p.exam.id)) fail('changed media under existing version: '+m.mediaId);
      if(!old) {
        if((await client.query('SELECT 1 FROM content_version WHERE content_version_id=$1',[cv])).rowCount) fail('content identity already belongs to another record: '+cv);
        plan('add media '+cv,`INSERT INTO content_version(content_version_id,kind,family,source_path,review_status,rights_status,content_sha256,exam_id)
          VALUES($1,'media','listening',$2,$3,$4,$5,$6)`,[cv,'content/exams/'+p.exam.id+'/manifest.json#'+cv,m.reviewStatus,m.rightsStatus,digest,p.exam.id]);
        commands.push([`INSERT INTO exam_media(media_id,version,exam_id,path,sha256,byte_length,duration_ms,mime_type,content_version_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[m.mediaId,m.version,p.exam.id,m.path,m.sha256,m.byteLength,m.durationMs,m.mimeType,cv]]);
      }
      media.set(cv,old||{media_id:m.mediaId,version:m.version,exam_id:p.exam.id,path:m.path,sha256:m.sha256,byte_length:m.byteLength,duration_ms:m.durationMs,
        mime_type:m.mimeType,content_version_id:cv,review_status:m.reviewStatus,rights_status:m.rightsStatus});
    }
    const sets=new Map();
    for(const s of p.sets) {
      const digest=packageHash(s);
      const old=(await client.query(`SELECT s.*,c.content_sha256,c.review_status,COALESCE(cr.basis,c.rights_status) AS rights_status
        FROM objective_set s JOIN content_version c ON c.content_version_id=s.content_version_id
        LEFT JOIN content_rights cr ON cr.content_version_id=c.content_version_id WHERE s.set_id=$1 AND s.version=$2`,[s.setId,s.version])).rows[0];
      if(old && (old.content_sha256!==digest || old.exam_id!==p.exam.id)) fail('changed set under existing version: '+s.setId);
      if(old) {sets.set(s.setId+'@'+s.version,old);continue;}
      const cv=s.setId+'@'+s.version;
      if((await client.query('SELECT 1 FROM content_version WHERE content_version_id=$1',[cv])).rowCount)
        fail('content identity already belongs to another record: '+cv);
      plan('add set '+cv,`INSERT INTO content_version(content_version_id,kind,family,source_path,review_status,rights_status,content_sha256,exam_id)
        VALUES($1,'task',$2,$3,$4,$5,$6,$7)`,[cv,s.family,'content/exams/'+p.exam.id+'/manifest.json#'+cv,s.reviewStatus,s.rightsStatus,digest,p.exam.id]);
      commands.push([`INSERT INTO objective_set(set_id,version,exam_id,family,section,part,title,payload,item_count,media_required,content_version_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)`,[s.setId,s.version,p.exam.id,s.family,s.section,s.part,s.title,canonicalJson(s.payload),s.itemCount,s.interaction==='fixed_audio',cv]]);
      commands.push(['INSERT INTO objective_key(set_id,version,answers,explanations) VALUES($1,$2,$3::jsonb,$4::jsonb)',[s.setId,s.version,canonicalJson(s.answers),canonicalJson(s.explanations)]]);
      sets.set(cv,{set_id:s.setId,version:s.version,exam_id:s.examId,family:s.family,section:s.section,part:s.part,payload:s.payload,item_count:s.itemCount,
        review_status:s.reviewStatus,rights_status:s.rightsStatus,media_required:s.interaction==='fixed_audio'});
    }
    const rubrics=new Map(),writingTasks=new Map();
    for(const r of p.rubrics||[]) {
      const cv=r.rubricId+'@'+r.version,digest=packageHash(r);
      const old=(await client.query(`SELECT r.*,c.content_sha256,c.review_status,COALESCE(cr.basis,c.rights_status) AS rights_status FROM rubric_version r
        JOIN content_version c USING(content_version_id) LEFT JOIN content_rights cr USING(content_version_id) WHERE rubric_id=$1 AND version=$2`,[r.rubricId,r.version])).rows[0];
      if(old && (old.content_sha256!==digest||old.exam_id!==p.exam.id)) fail('changed rubric under existing version');
      if(!old) {
        plan('add rubric '+cv,`INSERT INTO content_version(content_version_id,kind,family,source_path,review_status,rights_status,content_sha256,exam_id)
          VALUES($1,'rubric','writing',$2,$3,$4,$5,$6)`,[cv,'content/exams/'+p.exam.id+'/writing-manifest.json#'+cv,r.reviewStatus,r.rightsStatus,digest,p.exam.id]);
        commands.push([`INSERT INTO rubric_version(rubric_id,version,family,criteria,max_total,content_version_id,exam_id,policy,feedback_kind)
          VALUES($1,$2,'writing',$3::jsonb,NULL,$4,$5,$6,$7)`,[r.rubricId,r.version,canonicalJson(r.criteria),cv,p.exam.id,r.policy,r.feedbackKind]]);
      }
      rubrics.set(cv,old||{exam_id:r.examId,review_status:r.reviewStatus,rights_status:r.rightsStatus});
    }
    for(const t of p.writingTasks||[]) {
      const cv=t.taskId+'@'+t.version,digest=packageHash(t);
      const r=rubrics.get(t.rubricId+'@'+t.rubricVersion)||(await client.query(`SELECT r.*,c.review_status,COALESCE(cr.basis,c.rights_status) AS rights_status FROM rubric_version r JOIN content_version c USING(content_version_id) LEFT JOIN content_rights cr USING(content_version_id) WHERE rubric_id=$1 AND version=$2`,[t.rubricId,t.rubricVersion])).rows[0];
      if(!r||r.exam_id!==p.exam.id||!['generated','licensed','commissioned'].includes(r.rights_status)) fail('missing or incompatible exact rubric');
      const old=(await client.query(`SELECT t.*,c.content_sha256,c.review_status,COALESCE(cr.basis,c.rights_status) AS rights_status FROM task_version t
        JOIN content_version c USING(content_version_id) LEFT JOIN content_rights cr USING(content_version_id) WHERE task_id=$1 AND version=$2`,[t.taskId,t.version])).rows[0];
      if(old && (old.content_sha256!==digest||old.exam_id!==p.exam.id)) fail('changed writing task under existing version');
      if(!old) {
        plan('add writing task '+cv,`INSERT INTO content_version(content_version_id,kind,family,source_path,review_status,rights_status,content_sha256,exam_id)
          VALUES($1,'task','writing',$2,$3,$4,$5,$6)`,[cv,'content/exams/'+p.exam.id+'/writing-manifest.json#'+cv,t.reviewStatus,t.rightsStatus,digest,p.exam.id]);
        commands.push([`INSERT INTO task_version(task_id,version,family,register,topic,situation,adressat,leitpunkte,rubric_id,rubric_version,content_version_id,exam_id,section)
          VALUES($1,$2,'writing',$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12)`,[t.taskId,t.version,t.register,t.topic,t.situation,t.adressat,canonicalJson(t.leitpunkte),t.rubricId,t.rubricVersion,cv,t.examId,t.section]]);
      }
      writingTasks.set(cv,old||{exam_id:t.examId,family:t.family,section:t.section,review_status:t.reviewStatus,rights_status:t.rightsStatus,rubric_id:t.rubricId,rubric_version:t.rubricVersion});
    }
    for(const f of p.forms) {
      const formHash=packageHash({blueprintVersion:p.blueprint.version,form:f});
      const old=(await client.query('SELECT sha256 FROM exam_form WHERE exam_id=$1 AND form_id=$2 AND version=$3',[p.exam.id,f.id,f.version])).rows[0];
      if(old && old.sha256!==formHash) fail('changed form under existing version: '+f.id);
      const coverage=new Map();
      const formMedia=new Set();
      const largestResponses=[];
      for(const [i,m] of f.members.entries()) {
        const key=m.setId+'@'+m.version;
        let set=sets.get(key);
        if(!set) set=(await client.query(`SELECT s.*,c.review_status,COALESCE(cr.basis,c.rights_status) AS rights_status
          FROM objective_set s JOIN content_version c ON c.content_version_id=s.content_version_id
          LEFT JOIN content_rights cr ON cr.content_version_id=c.content_version_id WHERE s.set_id=$1 AND s.version=$2`,[m.setId,m.version])).rows[0];
        if(!set || set.exam_id!==p.exam.id || set.media_required!==(m.interaction==='fixed_audio') || set.item_count!==m.itemCount || !f.sections.includes(set.section)) fail('missing or incompatible exact set: '+key);
        const section=p.blueprint.sections.find(s=>s.id===set.section);
        const part=section?.parts.find(x=>x.family===set.family);
        if(!part || part.itemCount!==set.item_count || part.interaction!==m.interaction || part.mediaRequired!==set.media_required) fail('set/blueprint mismatch: '+key);
        const publicItems=objectiveItems(set.payload,m.interaction);
        if(publicItems.length!==m.itemCount) fail('payload count mismatch: '+key);
        if(m.interaction==='fixed_audio') {
          validatePlayback(part,p.exam.id);
          for(const recording of set.payload.recordings) {
            const identity=recording.mediaId+'@'+recording.mediaVersion;
            if(formMedia.has(identity)) fail('repeated media in form: '+identity);
            formMedia.add(identity);
            let asset=media.get(identity);
            if(!asset) {
              asset=(await client.query(`SELECT m.*,c.review_status,COALESCE(cr.basis,c.rights_status) AS rights_status
                FROM exam_media m JOIN content_version c USING(content_version_id) LEFT JOIN content_rights cr USING(content_version_id)
                WHERE media_id=$1 AND version=$2`,[recording.mediaId,recording.mediaVersion])).rows[0];
              if(asset) media.set(identity,asset);
            }
            if(!asset||asset.exam_id!==p.exam.id||!['generated','licensed','commissioned'].includes(asset.rights_status)) fail('missing or incompatible exact media: '+identity);
            if(p.release.state==='available'&&asset.review_status!=='approved') fail('media release needs exact qualified review: '+identity);
          }
        }
        for(const item of publicItems) {
          const answer=[null,...item.options].reduce((longest,value)=>Buffer.byteLength(JSON.stringify(value),'utf8')>Buffer.byteLength(JSON.stringify(longest),'utf8')?value:longest,null);
          largestResponses.push({setId:m.setId,version:m.version,itemId:item.id,answer});
        }
        const authored=p.sets.find(s=>s.setId===m.setId&&s.version===m.version);
        const answerKey=authored?.answers ?? (await client.query('SELECT answers FROM objective_key WHERE set_id=$1 AND version=$2',[m.setId,m.version])).rows[0]?.answers;
        if(!answerKey || Object.keys(answerKey).length!==publicItems.length || publicItems.some(item=>!item.options.includes(answerKey[item.id])))
          fail('invalid exact answer key: '+key);
        if(!['generated','licensed','commissioned'].includes(set.rights_status)) fail('unresolved rights: '+key);
        if(p.release.state==='available' && set.review_status!=='approved') fail('release needs exact qualified review: '+key);
        coverage.set(set.section+':'+set.family,(coverage.get(set.section+':'+set.family)||0)+1);
        if(!old) commands.push([`INSERT INTO exam_form_member(exam_id,form_id,form_version,position,set_id,set_version,interaction,item_count)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[p.exam.id,f.id,f.version,i,m.setId,m.version,m.interaction,m.itemCount]]);
      }
      for(const choice of f.writingChoices||[]) {
        let family;
        for(const o of choice.options) {
          const t=writingTasks.get(o.taskId+'@'+o.taskVersion)||(await client.query(`SELECT t.*,c.review_status,COALESCE(cr.basis,c.rights_status) AS rights_status FROM task_version t JOIN content_version c USING(content_version_id) LEFT JOIN content_rights cr USING(content_version_id) WHERE task_id=$1 AND version=$2`,[o.taskId,o.taskVersion])).rows[0];
          const part=p.blueprint.sections.find(x=>x.id===choice.section)?.parts.find(x=>x.family===t?.family);
          if(!t||t.exam_id!==p.exam.id||t.section!==choice.section||part?.interaction!=='writing_choice'||!['generated','licensed','commissioned'].includes(t.rights_status)) fail('missing or incompatible writing choice');
          const r=rubrics.get(t.rubric_id+'@'+t.rubric_version)||(await client.query(`SELECT r.*,c.review_status,COALESCE(cr.basis,c.rights_status) AS rights_status FROM rubric_version r JOIN content_version c USING(content_version_id) LEFT JOIN content_rights cr USING(content_version_id) WHERE rubric_id=$1 AND version=$2`,[t.rubric_id,t.rubric_version])).rows[0];
          if(!r||r.exam_id!==p.exam.id||!['generated','licensed','commissioned'].includes(r.rights_status)) fail('incompatible choice rubric');
          if(p.release.state==='available'&&(t.review_status!=='approved'||r.review_status!=='approved')) fail('writing needs qualified review');
          family=t.family;
        }
        coverage.set(choice.section+':'+family,(coverage.get(choice.section+':'+family)||0)+1);
      }
      // A section label means every part of that declared section, exactly once.
      for(const id of f.sections) for(const part of p.blueprint.sections.find(s=>s.id===id).parts)
        if(coverage.get(id+':'+part.family)!==1) fail('incomplete or repeated section coverage: '+id+'/'+part.family);
      const largestSave={expectedRevision:2147483646,eventId:'00000000-0000-4000-8000-000000000000',responses:largestResponses,position:{member:f.members.length-1,item:99}};
      if(Buffer.byteLength(JSON.stringify(largestSave),'utf8')>BODY_LIMIT_BYTES) fail('form exceeds saved response byte limit');
      if(!old) {
        changes.push('add form '+f.id+'@'+f.version);
        // Insert the form before its already planned members, all after blueprint/set commands.
        const firstMember=commands.findIndex(([sql,args])=>sql.startsWith('INSERT INTO exam_form_member')&&args[1]===f.id&&args[2]===f.version);
        commands.splice(firstMember<0?commands.length:firstMember,0,['INSERT INTO exam_form(exam_id,form_id,version,blueprint_version,payload,sha256) VALUES($1,$2,$3,$4,$5::jsonb,$6)',
          [p.exam.id,f.id,f.version,p.blueprint.version,canonicalJson(f),formHash]]);
      }
    }
    for(const version of p.release.resumeBlockedReleases) {
      if(version===p.release.version) continue;
      if(!(await client.query('SELECT 1 FROM exam_release WHERE exam_id=$1 AND version=$2',[p.exam.id,version])).rowCount) fail('unknown blocked release: '+version);
    }
    const digest=packageHash(p);
    const release=(await client.query('SELECT sha256 FROM exam_release WHERE exam_id=$1 AND version=$2',[p.exam.id,p.release.version])).rows[0];
    if(release && release.sha256!==digest) fail('changed release under existing version');
    if(!release) {
      // Store only public source metadata in tables granted to the learner role.
      const publicManifest={...p,sets:p.sets.map(({answers,explanations,...rest})=>rest)};
      if(p.media!==undefined) publicManifest.media=p.media.map(({path,...rest})=>rest);
      plan('add release '+p.release.version,'INSERT INTO exam_release(exam_id,version,blueprint_version,state,manifest,sha256,publisher) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)',
        [p.exam.id,p.release.version,p.blueprint.version,p.release.state,canonicalJson(publicManifest),digest,publisher]);
      for(const f of p.forms) commands.push(['INSERT INTO exam_release_form(exam_id,release_version,form_id,form_version) VALUES($1,$2,$3,$4)',[p.exam.id,p.release.version,f.id,f.version]]);
      plan('activate release '+p.release.version,'INSERT INTO exam_release_head(exam_id,release_version) VALUES($1,$2) ON CONFLICT(exam_id) DO UPDATE SET release_version=excluded.release_version',[p.exam.id,p.release.version]);
    }
    if(!dryRun) for(const [sql,args] of commands) await client.query(sql,args);
    await client.query(dryRun?'ROLLBACK':'COMMIT');
    return {examId:p.exam.id,releaseVersion:p.release.version,sha256:digest,publisher,dryRun,changes,unchanged:changes.length===0};
  } catch(e) {if(begun) await client.query('ROLLBACK').catch(()=>{});throw e;} finally {client.release();}
}

/** Initial source package is imported through the same publisher contract, not a content SQL seed. */
export async function importDefaultPackage(pool) {
  const input=JSON.parse(await readFile(new URL('../../content/exams/telc-deutsch-b1/manifest.json',import.meta.url),'utf8'));
  return importPackage(pool,input,{publisher:'bundled-telc-source'});
}
