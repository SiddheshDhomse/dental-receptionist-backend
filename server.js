require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const twilio = require('twilio');

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

function getClinicId(req) {
  return req.body?.message?.call?.assistantOverrides?.metadata?.clinic_id
    || req.headers['x-clinic-id']
    || '22fd08d0-2860-4594-afd2-2affd4e1642b';
}

// ── HEALTH CHECK ─────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'AI Receptionist backend is running!' });
});

// ── BOOK APPOINTMENT ─────────────────────────────────────────
app.post('/api/book-appointment', async (req, res) => {
  try {
    const args = req.body?.message?.toolCallList?.[0]?.function?.arguments || req.body;
    const {
      patient_name, patient_phone, patient_email,
      appointment_date, appointment_time,
      appointment_type, is_new_patient, notes
    } = args;

    const clinicId = getClinicId(req);

    const { data: clinic } = await supabase
      .from('clinics')
      .select('name, address, phone, timezone')
      .eq('id', clinicId)
      .single();

    await supabase.from('appointments').insert({
      clinic_id: clinicId,
      patient_name,
      patient_phone,
      patient_email,
      appointment_date,
      appointment_time: appointment_time + ':00',
      appointment_type,
      is_new_patient: is_new_patient || false,
      notes,
      status: 'confirmed',
      booked_via: 'ai_receptionist'
    });

    if (patient_phone) {
      await twilioClient.messages.create({
        to: patient_phone,
        from: process.env.TWILIO_FROM_NUMBER,
        body: `Hi ${patient_name}! Your ${appointment_type} at ${clinic?.name} is confirmed for ${appointment_date} at ${appointment_time}. Address: ${clinic?.address}. See you soon!`
      });
    }

    res.json({
      results: [{
        toolCallId: req.body?.message?.toolCallList?.[0]?.id || 'test',
        result: `Appointment confirmed for ${patient_name} on ${appointment_date} at ${appointment_time}. Confirmation SMS sent.`
      }]
    });

  } catch (err) {
    console.error('book-appointment error:', err);
    res.json({
      results: [{
        toolCallId: req.body?.message?.toolCallList?.[0]?.id || 'test',
        result: 'Booking failed. Please take their details and have the team confirm manually.'
      }]
    });
  }
});

// ── SAVE LEAD ────────────────────────────────────────────────
app.post('/api/save-lead', async (req, res) => {
  try {
    const args = req.body?.message?.toolCallList?.[0]?.function?.arguments || req.body;
    const { patient_name, patient_phone, patient_email, reason, callback_requested } = args;
    const clinicId = getClinicId(req);

    await supabase.from('leads').insert({
      clinic_id: clinicId,
      name: patient_name,
      phone: patient_phone,
      email: patient_email,
      reason,
      callback_requested: callback_requested || false
    });

    if (callback_requested) {
      const { data: clinic } = await supabase
        .from('clinics')
        .select('staff_phone, name')
        .eq('id', clinicId)
        .single();

      const staffPhone = clinic?.staff_phone || process.env.CLINIC_STAFF_PHONE;
      if (staffPhone) {
        await twilioClient.messages.create({
          to: staffPhone,
          from: process.env.TWILIO_FROM_NUMBER,
          body: `Callback Request | ${clinic?.name}\nPatient: ${patient_name}\nPhone: ${patient_phone}\nReason: ${reason}`
        });
      }
    }

    res.json({
      results: [{
        toolCallId: req.body?.message?.toolCallList?.[0]?.id || 'test',
        result: callback_requested
          ? 'Lead saved. Team has been notified and will call back shortly.'
          : 'Details saved. Is there anything else I can help with?'
      }]
    });

  } catch (err) {
    console.error('save-lead error:', err);
    res.json({
      results: [{
        toolCallId: req.body?.message?.toolCallList?.[0]?.id || 'test',
        result: 'Details noted. Our team will follow up soon.'
      }]
    });
  }
});

// ── ESCALATION ───────────────────────────────────────────────
app.post('/api/escalate', async (req, res) => {
  try {
    const args = req.body?.message?.toolCallList?.[0]?.function?.arguments || req.body;
    const { patient_name, patient_phone, urgency, reason } = args;
    const clinicId = getClinicId(req);

    await supabase.from('escalations').insert({
      clinic_id: clinicId,
      patient_name,
      patient_phone,
      urgency,
      reason
    });

    const { data: clinic } = await supabase
      .from('clinics')
      .select('staff_phone, emergency_phone, name')
      .eq('id', clinicId)
      .single();

    const emoji = urgency === 'emergency' ? '🚨' : '⚠️';
    const targetPhone = urgency === 'emergency'
      ? (clinic?.emergency_phone || clinic?.staff_phone || process.env.CLINIC_STAFF_PHONE)
      : (clinic?.staff_phone || process.env.CLINIC_STAFF_PHONE);

    await twilioClient.messages.create({
      to: targetPhone,
      from: process.env.TWILIO_FROM_NUMBER,
      body: `${emoji} ${urgency.toUpperCase()} | ${clinic?.name}\nPatient: ${patient_name}\nPhone: ${patient_phone}\nReason: ${reason}`
    });

    res.json({
      results: [{
        toolCallId: req.body?.message?.toolCallList?.[0]?.id || 'test',
        result: urgency === 'emergency'
          ? 'Emergency team alerted immediately. If life-threatening please call 911.'
          : 'Our team has been notified and will call you back shortly.'
      }]
    });

  } catch (err) {
    console.error('escalate error:', err);
    res.json({
      results: [{
        toolCallId: req.body?.message?.toolCallList?.[0]?.id || 'test',
        result: 'Please call the clinic directly or dial 911 if this is an emergency.'
      }]
    });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});