'use strict';
const handleMessage = require('./engine');

console.log(` process.env ${JSON.stringify(process.env)}`);

const context = {
   idScope: process.env.ID_SCOPE,
   log: console.log, 
   getSecret: ()=>{ return process.env.IOTC_SAS_KEY}
  };


const port = 3030;
const express = require('express');
const app = express();
const bodyParser = require('body-parser')
const jsonParser = bodyParser.json();



// POST /api/device to send telemetry for a given device
app.post('/api/device/:deviceId', jsonParser, async function (req, res) {
  const deviceId  = req.params.deviceId;
  const payload = req.body.measurements;
  try{
    const response = await handleMessage(context, {deviceId}, payload );
    res.status(200).send(response);
  }catch(ex){
    if(ex.statusCode){
      res.status(ex.statusCode).send(ex);
    } else {
      res.status(500).send(ex);
    }
  }  
});

app.listen(port, () => console.log(`IotCentral bridge module starting on ${port}!`))